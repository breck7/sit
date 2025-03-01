// NPM ecosystem includes
const path = require("path")
const fs = require("fs")
const fastDiff = require("fast-diff")
const git = require("isomorphic-git")
const crypto = require("crypto")
const { createHash } = crypto

// Create a deterministic blob hash (for a file)
async function createBlobHash(content) {
  let { oid, type, object, format } = await git.hashBlob({
    object: content,
  })
  return oid
}

// Particles Includes
const { Disk } = require("scrollsdk/products/Disk.node.js")
const { Particle } = require("scrollsdk/products/Particle.js")

const fileOps = new Set(
  "write delete mkdir patch rename binary touch".split(" "),
)
const isFileOp = (item) => fileOps.has(item.cue)

const binaryExtensions = new Set(
  "ds_store thumbs.db pdf png jpg jpeg gif webp bmp tiff ico eps raw cr2 nef heic doc docx xls xlsx ppt pptx odt ods odp pages numbers key zip tar gz 7z rar bz2 dmg iso tgz exe dll so dylib bin app msi deb rpm mp3 wav ogg mp4 avi mov wmv flv mkv".split(
    " ",
  ),
)
const hasBinaryExtension = (fileName) => {
  const extension = fileName.split(".").pop().toLowerCase()
  return binaryExtensions.has(extension)
}

// Helper function to detect if a file should be base64 encoded.
function shouldBase64Encode(buffer, fullPath) {
  if (hasBinaryExtension(fullPath)) return true
  // Check for null bytes which typically indicate binary content
  const BINARY_CHECK_BYTES = 8000 // Check first 8KB
  const slice = buffer.slice(0, Math.min(buffer.length, BINARY_CHECK_BYTES))
  return slice.includes(0)
}

const calculateCommitHash = (
  author,
  timestamp,
  message,
  parentHash = null,
  stagedChanges = "",
) => {
  // Build hash content in consistent order
  const hashParts = [
    `author ${author}`,
    `timestamp ${timestamp}`,
    `message ${message}`,
  ]

  // Only include parent if it exists
  if (parentHash) {
    hashParts.push(`parent ${parentHash}`)
  }

  // Include staged changes if any
  if (stagedChanges) {
    hashParts.push(stagedChanges)
  }

  // Calculate hash
  return createHash("sha1").update(hashParts.join("\n")).digest("hex")
}

class PatchHandler {
  // Generate a patch between old and new text
  createPatch(oldText, newText) {
    const diffs = fastDiff(oldText, newText)
    let position = 0
    const operations = []

    for (const [type, text] of diffs) {
      if (type === fastDiff.DELETE) {
        // Delete operation
        operations.push({
          type: "delete",
          position,
          length: text.length,
        })
      } else if (type === fastDiff.INSERT) {
        // Insert operation
        operations.push({
          type: "insert",
          position,
          text,
        })
        position += text.length
      } else {
        // Equal - just advance position
        position += text.length
      }
    }

    return this.serializeOperations(operations)
  }

  // Convert operations to our particle syntax
  serializeOperations(operations) {
    const lines = operations.map((op) => {
      if (op.type === "delete") {
        return `delete ${op.position} ${op.length}`
      } else if (op.type === "insert") {
        const { text } = op
        if (text.includes("\n"))
          return `insert ${op.position}\n ${op.text.replace(/\n/g, "\n ")}`
        else return `insert ${op.position} ${op.text}`
      }
    })

    return lines.join("\n")
  }

  // Parse patch from our particle syntax
  deserializePatch(patchText) {
    const operations = []
    const particle = new Particle(patchText)

    particle.forEach((op) => {
      const { atoms, cue } = op
      if (cue === "delete")
        operations.push({
          type: "delete",
          position: parseInt(atoms[1]),
          length: parseInt(atoms[2]),
        })
      else if (cue === "insert")
        operations.push({
          type: "insert",
          position: parseInt(atoms[1]),
          text: op.length
            ? op.subparticlesToString()
            : atoms.slice(2).join(" "),
        })
    })

    return operations
  }

  // Apply patch to text
  applyPatch(text, patchText) {
    const operations = this.deserializePatch(patchText)
    let result = text

    for (const op of operations) {
      if (op.type === "delete") {
        result =
          result.slice(0, op.position) + result.slice(op.position + op.length)
      } else if (op.type === "insert") {
        result =
          result.slice(0, op.position) + op.text + result.slice(op.position)
      }
    }

    return result
  }

  // Determine if we should use patch or full write
  shouldUsePatch(oldText, newText) {
    if (!oldText) return false

    const diffs = fastDiff(oldText, newText)
    let changedChars = 0
    let totalChars = oldText.length

    for (const [type, text] of diffs) {
      if (type !== fastDiff.EQUAL) {
        changedChars += text.length
      }
    }

    // Use patch if less than 50% changed
    return changedChars / totalChars < 0.5
  }
}

const patchHandler = new PatchHandler()

class HistoryParticle extends Particle {
  get lastCommit() {
    return this.getParticles("commit").pop()
  }
  get stagedChanges() {
    const { lastCommit } = this
    return lastCommit.getYoungerSiblings().filter(isFileOp)
  }

  get repoName() {
    return path.basename(this.filepath)
  }

  get bytes() {
    return this.toString().length
  }

  stash() {
    const { lastCommit } = this
    const items = lastCommit.getYoungerSiblings().filter(isFileOp)
    const stash = new Particle()
    if (!items.length) return stash
    items.forEach((particle) => {
      stash.appendParticle(particle)
    })
    items.forEach((item) => item.destroy())
    this.appendLineAndSubparticles("stash", stash.subparticlesToString())
    return stash
  }

  unstash() {
    const lastStash = this.getParticles("stash").pop()
    lastStash.forEach((item) => {
      this.appendParticle(item)
    })
    lastStash.destroy()
    return this
  }

  save() {
    Disk.write(this.filepath, this.toString() + "\n")
  }

  appendAndSave(content) {
    fs.appendFileSync(this.filepath, content, "utf8")
  }

  get committedChanges() {
    const { lastCommit } = this
    const items = lastCommit.getOlderSiblings()
    return items.filter(isFileOp) // todo: add proper parsing
  }

  get commits() {
    return this.filter((particle) => particle.cue === "commit")
  }

  get filepath() {
    return this.getLine()
  }

  reset() {
    // Todo: do this via faster truncate
    const { stagedChanges } = this
    stagedChanges.forEach((op) => op.destroy())
    return this
  }

  get committedTree() {
    const { lastCommit } = this
    return this.getCommittedTreeUntil((particle) => particle === lastCommit)
  }

  get stagedTree() {
    return this.getCommittedTreeUntil()
  }

  getCommittedTreeUntil(stopFn = () => false) {
    const state = new Map()
    // Split into operations
    for (let particle of this.getSubparticles()) {
      const { cue, atoms } = particle
      if (cue === "commit" && stopFn(particle)) return state
      const filepath = atoms[1]
      if (cue === "write")
        state.set(filepath, {
          type: "file",
          content: particle.subparticlesToString(),
        })
      else if (cue === "binary")
        state.set(filepath, {
          type: "binary",
          content: particle.subparticlesToString(),
        })
      else if (cue === "patch") {
        const currentFile = state.get(filepath)
        const newContent = patchHandler.applyPatch(
          currentFile.content,
          particle.subparticlesToString(),
        )
        state.set(filepath, {
          type: "file",
          content: newContent,
        })
      } else if (cue === "mkdir") state.set(filepath, { type: "directory" })
      else if (cue === "delete") state.delete(filepath)
      else if (cue === "touch")
        state.set(filepath, {
          type: "file",
          content: "",
        })
      else if (cue === "rename") {
        state.set(atoms[2], {
          type: "file",
          content: state.get(filepath).content,
        })
        state.delete(filepath)
      }
    }
    return state
  }

  get commitCount() {
    return this.commits.length
  }

  get stats() {
    // Initialize counters
    const stats = {
      commits: this.commitCount,
      writes: 0,
      deletes: 0,
      mkdirs: 0,
      renames: 0,
      patches: 0,
    }

    // Count operations and commits
    this.committedChanges.forEach((particle) => {
      if (particle.cue === "write") stats.writes++
      else if (particle.cue === "delete") stats.deletes++
      else if (particle.cue === "rename") stats.renames++
      else if (particle.cue === "patches") stats.patches++
      else if (particle.cue === "mkdir") stats.mkdirs++
    })

    // Get committed tree stats
    const committedTree = this.committedTree
    stats.trackedFiles = 0
    stats.trackedFolders = 0
    stats.totalSize = 0

    for (const [filepath, committedNode] of committedTree) {
      if (committedNode.type === "file") {
        stats.trackedFiles++
        stats.totalSize += committedNode.content.length
      } else {
        stats.trackedFolders++
      }
    }

    return `# Stats for '${this.repoName}'
Commits: ${stats.commits}
Operations: ${stats.writes + stats.deletes + stats.mkdirs}
 Writes: ${stats.writes}
 Deletes: ${stats.deletes}
 Mkdirs: ${stats.mkdirs}
Tree:
 Tracked files: ${stats.trackedFiles}
 Tracked subfolders: ${stats.trackedFolders}
 Live size: ${(stats.totalSize / 1024).toFixed(2)} KB
History size: ${(this.bytes / 1024).toFixed(2)} KB`
  }

  get cwd() {
    return path.dirname(this.filepath)
  }

  async addFiles(files) {
    const changes = await this.diff(files)
    if (!changes.length) return changes
    this.appendAndSave(changes + "\n")
    return changes
  }

  async diff(files) {
    const liveTree = await this.scanWorkingDirectory(this.cwd, files)
    const changes = this._generateChanges(this.stagedTree, liveTree, files)
    return this.formatChanges(changes)
  }

  async scanWorkingDirectory(cwd, files) {
    const liveTree = new Map()
    for (const scanPath of files) {
      const fullPath = path.join(cwd, scanPath)
      await this.scanPath(fullPath, cwd, liveTree)
    }
    return liveTree
  }

  async scanPath(fullPath, rootPath, liveTree) {
    const relativePath = path.relative(rootPath, fullPath)
    const ignore = (filepath) => {
      if (filepath.endsWith(".sit")) return true
      if (filepath === "node_modules") return true
      if (filepath === ".git") return true
      if (filepath === ".DS_Store") return true
      return false
    }

    if (ignore(relativePath)) {
      return
    }

    if (!fs.existsSync(fullPath)) {
      return
    }
    const stats = fs.statSync(fullPath)

    if (stats.isDirectory()) {
      if (relativePath) liveTree.set(relativePath, { type: "directory" })
      const entries = fs.readdirSync(fullPath)
      for (const entry of entries) {
        await this.scanPath(path.join(fullPath, entry), rootPath, liveTree)
      }
    } else if (stats.isFile()) {
      // Read file as buffer to check if binary
      const buffer = fs.readFileSync(fullPath)
      const base64 = shouldBase64Encode(buffer, fullPath)

      if (base64) {
        // Handle binary file
        const base64Content = buffer.toString("base64")
        liveTree.set(relativePath, {
          type: "binary",
          content: base64Content,
          size: stats.size,
          hash: createHash("sha1").update(buffer).digest("hex"),
        })
      } else {
        // Handle text file
        const content = buffer.toString("utf8")
        liveTree.set(relativePath, {
          type: "file",
          content,
          hash: await createBlobHash(content),
        })
      }
    }
  }

  _generateChanges(oldTree, newTree, files) {
    const changes = []

    // Find new and modified files
    for (const [path, liveNode] of newTree) {
      const oldNode = oldTree.get(path)

      if (!oldNode) {
        // New file/directory
        if (liveNode.type === "directory") {
          changes.push({
            type: "mkdir",
            path,
          })
        } else if (liveNode.type === "binary") {
          changes.push({
            type: "binary",
            path,
            content: liveNode.content,
            size: liveNode.size,
            hash: liveNode.hash,
          })
        } else {
          if (liveNode.content === "")
            changes.push({
              type: "touch",
              path,
              content: "",
            })
          else
            changes.push({
              type: "write",
              path,
              content: liveNode.content,
              hash: liveNode.hash,
            })
        }
      } else if (
        (liveNode.type === "file" || liveNode.type === "binary") &&
        (oldNode.type === "file" || oldNode.type === "binary") &&
        liveNode.content !== oldNode.content
      ) {
        // Check if type changed between binary and text
        if (liveNode.type !== oldNode.type) {
          changes.push({
            type: liveNode.type === "binary" ? "binary" : "write",
            path,
            content: liveNode.content,
            size: liveNode.type === "binary" ? liveNode.size : undefined,
            hash: liveNode.hash,
          })
        } else if (liveNode.type === "binary") {
          changes.push({
            type: "binary",
            path,
            content: liveNode.content,
            size: liveNode.size,
            hash: liveNode.hash,
          })
        } else if (
          patchHandler.shouldUsePatch(oldNode.content, liveNode.content)
        ) {
          changes.push({
            type: "patch",
            path,
            content: patchHandler.createPatch(
              oldNode.content,
              liveNode.content,
            ),
            hash: liveNode.hash,
          })
        } else {
          changes.push({
            type: "write",
            path,
            content: liveNode.content,
            hash: liveNode.hash,
          })
        }
      }
    }

    // Find deleted files - only check files in our specified files list
    for (const [path, oldNode] of oldTree) {
      if (files.includes(path) && !newTree.has(path)) {
        changes.push({
          type: "delete",
          path,
        })
      }
    }

    // Handle renames (same as before)
    const writes = changes.filter(
      (change) => change.type === "write" || change.type === "binary",
    )
    const deletes = changes.filter((change) => change.type === "delete")
    const renames = []
    deletes.forEach((change) => {
      const deletedContent = oldTree.get(change.path).content
      const hit = writes.find((change) => change.content === deletedContent)
      if (hit) {
        hit.drop = true
        change.drop = true
        renames.push({ type: "rename", from: change.path, to: hit.path })
      }
    })

    return changes.filter((change) => !change.drop).concat(renames)
  }

  formatChanges(changes) {
    return changes
      .map((change) => {
        switch (change.type) {
          case "write":
            return `write ${change.path} ${change.hash}\n ${change.content.replace(/\n/g, "\n ")}`
          case "touch":
            return `touch ${change.path}`
          case "binary":
            return `binary ${change.path} ${change.hash} ${change.size}\n ${change.content}`
          case "patch":
            return `patch ${change.path} ${change.hash}\n ${change.content.replace(/\n/g, "\n ")}`
          case "mkdir":
            return `mkdir ${change.path}`
          case "rename":
            return `rename ${change.from} ${change.to}`
          case "delete":
            return `delete ${change.path}`
          default:
            throw new Error(`Unknown change type`)
        }
      })
      .join("\n")
  }

  async getUnstagedChanges() {
    // Scan current working directory
    const liveTree = await this.scanWorkingDirectory(this.cwd, ["."])
    const changes = []
    const { stagedTree } = this

    for (const [filepath, liveNode] of liveTree) {
      const stagedNode = stagedTree.get(filepath)
      if (!stagedNode) {
        // New file/directory
        changes.push({
          type: liveNode.type === "directory" ? "mkdir" : "write",
          path: filepath,
        })
      } else if (
        liveNode.type === "file" &&
        stagedNode.type === "file" &&
        liveNode.content !== stagedNode.content
      ) {
        // Modified file
        changes.push({
          type: "patch",
          path: filepath,
        })
      }
    }

    // Find deleted files
    for (const [filepath, liveNode] of stagedTree) {
      if (!liveTree.has(filepath)) {
        changes.push({
          type: "deleted",
          path: filepath,
        })
      }
    }

    return changes
  }

  addCommit(message) {
    const lastCommitHash = this.lastCommit.get("id")
    const order = this.commitCount + 1

    // Get all staged changes (everything after last commit)
    const stagedChanges = this.stagedChanges
    // Create commit content
    const timestamp = new Date().toISOString()
    const author = process.env.USER || "Unknown"

    // Calculate commit hash using helper
    const hash = calculateCommitHash(
      author,
      timestamp,
      message || "",
      lastCommitHash,
      stagedChanges,
    )

    // Format new commit
    const commitContent = `commit
 author ${author}
 timestamp ${timestamp}
 order ${order}${message.length ? `\n message ${message}` : ""}
 parent ${lastCommitHash}
 id ${hash}\n`

    this.appendAndSave(commitContent)
    return hash
  }

  async checkoutLatestTo(destination) {
    const { stagedTree } = this

    // Track created directories to avoid duplication
    const createdDirs = new Set()

    // Ensure parent directories exist
    const ensureParentDir = (filepath) => {
      const parentDir = path.dirname(filepath)
      if (parentDir === "." || createdDirs.has(parentDir)) return

      // Create all parent directories recursively
      fs.mkdirSync(path.join(destination, parentDir), { recursive: true })
      createdDirs.add(parentDir)
    }

    // First pass: create all directories
    for (const [filepath, stagedNode] of stagedTree) {
      if (stagedNode.type === "directory") {
        const fullPath = path.join(destination, filepath)
        if (!fs.existsSync(fullPath)) {
          fs.mkdirSync(fullPath, { recursive: true })
          createdDirs.add(filepath)
        }
      }
    }

    // Second pass: write all files
    for (const [filepath, stagedNode] of stagedTree) {
      if (stagedNode.type === "file" || stagedNode.type === "binary") {
        const fullPath = path.join(destination, filepath)
        ensureParentDir(filepath)

        if (stagedNode.type === "binary") {
          // Convert base64 content back to buffer and write
          const buffer = Buffer.from(stagedNode.content, "base64")
          fs.writeFileSync(fullPath, buffer)
        } else {
          // Write text file
          fs.writeFileSync(fullPath, stagedNode.content, "utf8")
        }
      }
    }
  }

  // Helper function to find the target commit based on query (order or hash)
  findTargetCommit(query) {
    const commits = this.commits

    // Check if query is a number (order)
    if (/^\d+$/.test(query)) {
      const order = parseInt(query)
      return commits.find((commit) => {
        const commitOrder = commit.get("order")
        return commitOrder && parseInt(commitOrder) === order
      })
    }

    // Otherwise treat as hash (full or partial)
    return commits.find((commit) => {
      const hash = commit.get("id")
      return hash && hash.includes(query)
    })
  }

  // Apply the checkout by deleting tracked files and replaying the target state
  async applyCheckout(cwd, targetTree) {
    // If targetTree is null, use the stagedTree (latest state)
    const tree = targetTree || this.stagedTree
    const currentTree = this.stagedTree

    // Get all currently tracked files
    const trackedFiles = Array.from(currentTree.keys()).filter(
      (key) =>
        currentTree.get(key).type === "file" ||
        currentTree.get(key).type === "binary",
    )

    // Get all tracked directories
    const trackedDirs = Array.from(currentTree.keys())
      .filter((key) => currentTree.get(key).type === "directory")
      .sort((a, b) => b.length - a.length) // Sort by depth (deepest first)

    // Files that will exist after checkout
    const targetFiles = new Set(
      Array.from(tree.keys()).filter(
        (key) =>
          tree.get(key).type === "file" || tree.get(key).type === "binary",
      ),
    )

    // Step 1: Delete tracked files that aren't in the target tree
    for (const filepath of trackedFiles) {
      if (!targetFiles.has(filepath)) {
        const fullPath = path.join(cwd, filepath)
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath)
        }
      }
    }

    // Step 2: Delete empty tracked directories
    // Start with deepest directories and work up
    for (const dirpath of trackedDirs) {
      const fullPath = path.join(cwd, dirpath)

      if (fs.existsSync(fullPath)) {
        // Only delete if directory is empty (no untracked files)
        try {
          const contents = fs.readdirSync(fullPath)
          if (contents.length === 0) {
            fs.rmdirSync(fullPath)
          }
        } catch (error) {
          console.error(error)
        }
      }
    }

    // Step 3: Apply the target tree state
    await this.writeTree(tree, cwd)
  }

  async writeTree(newTree, destination) {
    // Track created directories to avoid duplication
    const createdDirs = new Set()

    // Ensure parent directories exist
    const ensureParentDir = (filepath) => {
      const parentDir = path.dirname(filepath)
      if (parentDir === "." || createdDirs.has(parentDir)) return

      // Create all parent directories recursively
      fs.mkdirSync(path.join(destination, parentDir), { recursive: true })
      createdDirs.add(parentDir)
    }

    // First pass: create all directories
    for (const [filepath, newNode] of newTree) {
      if (newNode.type === "directory") {
        const fullPath = path.join(destination, filepath)
        if (!fs.existsSync(fullPath)) {
          fs.mkdirSync(fullPath, { recursive: true })
          createdDirs.add(filepath)
        }
      }
    }

    // Second pass: write all files
    for (const [filepath, newNode] of newTree) {
      if (newNode.type === "file" || newNode.type === "binary") {
        const fullPath = path.join(destination, filepath)
        ensureParentDir(filepath)

        const fileExists = fs.existsSync(fullPath)

        if (newNode.type === "binary") {
          // Convert base64 content back to buffer and write
          const buffer = Buffer.from(newNode.content, "base64")
          fs.writeFileSync(fullPath, buffer)
        } else {
          // Write text file
          fs.writeFileSync(fullPath, newNode.content, "utf8")
        }

        if (!fileExists) {
        } else {
        }
      }
    }
  }
}

module.exports = { HistoryParticle, calculateCommitHash, hasBinaryExtension }

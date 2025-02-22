const { execSync, exec } = require("child_process")
const { promisify } = require("util")
const fs = require("fs")
const path = require("path")
const { HistoryParticle, calculateCommitHash } = require("./HistoryParticle.js")

const execAsync = promisify(exec)

class GitToSit {
  constructor(gitDir, onProgress) {
    this.gitDir = gitDir
    this.historyParticle = new HistoryParticle("", null)
    this.onProgress = onProgress || (() => {})
  }

  // Check if directory is a git repository
  async isGitRepo() {
    try {
      await execAsync("git rev-parse --is-inside-work-tree", {
        cwd: this.gitDir,
      })
      return true
    } catch (error) {
      return false
    }
  }

  // Get all commit hashes in reverse chronological order
  async getCommitHashes() {
    const { stdout } = await execAsync("git log --reverse --format=%H", {
      cwd: this.gitDir,
    })
    return stdout.trim().split("\n")
  }

  // Get commit details for a specific hash
  async getCommitDetails(hash) {
    const { stdout } = await execAsync(
      `git show -s --format="%an <%ae>%n%at%n%B" ${hash}`,
      { cwd: this.gitDir },
    )
    const [author, timestamp, ...messageParts] = stdout.trim().split("\n")
    return {
      author,
      timestamp: new Date(parseInt(timestamp) * 1000).toISOString(),
      message: messageParts.join("\n").trim(),
    }
  }

  // Get changed files between commits
  async getChangedFiles(currentHash, parentHash = null) {
    const command = parentHash
      ? `git diff --name-status ${parentHash} ${currentHash}`
      : `git show --name-status --format="" ${currentHash}`

    const { stdout } = await execAsync(command, { cwd: this.gitDir })
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...pathParts] = line.split("\t")
        return { status, path: pathParts.join("\t") }
      })
  }

  // Extract file content at specific commit using git show
  async extractFilesToTemp(hash) {
    const tempDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "sit-"))
    await execAsync(`git archive ${hash} | tar x -C ${tempDir}`, {
      cwd: this.gitDir,
    })
    return tempDir
  }

  // Clean up temp directory
  cleanupTemp(tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  // Convert Git status to Sit operation
  getSitOperation(status) {
    switch (status) {
      case "A":
        return "write"
      case "M":
        return "write"
      case "D":
        return "delete"
      case "R":
        return "rename"
      default:
        return null
    }
  }

  // Process files for a commit and generate changes using HistoryParticle
  async processCommitChanges(hash, changes) {
    const tempDir = await this.extractFilesToTemp(hash)
    const fileChanges = []

    try {
      for (const change of changes) {
        const operation = this.getSitOperation(change.status)
        if (!operation) continue

        if (operation === "delete") {
          fileChanges.push({
            type: "delete",
            path: change.path,
          })
        } else if (operation === "write") {
          const filePath = path.join(tempDir, change.path)
          if (fs.existsSync(filePath)) {
            // Use HistoryParticle's scanPath to detect binary/text and handle appropriately
            const state = new Map()
            this.historyParticle.scanPath(filePath, tempDir, state)
            const fileInfo = state.get(change.path)

            if (fileInfo) {
              if (fileInfo.type === "binary") {
                fileChanges.push({
                  type: "binary",
                  path: change.path,
                  content: fileInfo.content,
                  size: fileInfo.size,
                  hash: fileInfo.hash,
                })
              } else {
                fileChanges.push({
                  type: "write",
                  path: change.path,
                  content: fileInfo.content,
                  hash: fileInfo.hash,
                })
              }
            }
          }
        }
      }
    } finally {
      this.cleanupTemp(tempDir)
    }

    // Use HistoryParticle's formatChanges to generate consistent output
    return this.historyParticle.formatChanges(fileChanges) + "\n"
  }

  // Main conversion function
  async convert(outputPath) {
    if (!(await this.isGitRepo())) {
      throw new Error("Not a git repository")
    }

    const writeStream = fs.createWriteStream(outputPath)
    const commitHashes = await this.getCommitHashes()
    const totalCommits = commitHashes.length

    // Process each commit
    for (let i = 0; i < commitHashes.length; i++) {
      const hash = commitHashes[i]
      const parentHash = i > 0 ? commitHashes[i - 1] : null
      const details = await this.getCommitDetails(hash)

      // Calculate commit hash using the same method as HistoryParticle
      const changes = await this.getChangedFiles(hash, parentHash)
      const formattedChanges = await this.processCommitChanges(hash, changes)

      // Generate commit content using calculateCommitHash from HistoryParticle
      const commitHash = calculateCommitHash(
        details.author,
        details.timestamp,
        details.message,
        parentHash,
        formattedChanges,
      )

      // Write changes
      writeStream.write(formattedChanges)

      // Write commit header
      writeStream.write(
        `commit\n author ${details.author}\n timestamp ${details.timestamp}${
          details.message ? `\n message ${details.message}` : ""
        }\n order ${i + 1}${parentHash ? `\n parent ${parentHash}` : ""}\n id ${commitHash}\n`,
      )

      // Update progress
      this.onProgress({
        current: i + 1,
        total: totalCommits,
        percentage: Math.round(((i + 1) / totalCommits) * 100),
      })
    }

    writeStream.end()
    return new Promise((resolve, reject) => {
      writeStream.on("finish", resolve)
      writeStream.on("error", reject)
    })
  }
}

module.exports = { GitToSit }

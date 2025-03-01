#!/usr/bin/env node

const fs = require("fs")
const path = require("path")
const zlib = require("zlib")
const crypto = require("crypto")
const { execSync } = require("child_process")

class GitToScroll {
  constructor(gitDir, outputFile) {
    this.gitDir = gitDir
    this.outputFile = outputFile
    this.objectsDir = path.join(gitDir, "objects")
    this.output = []
    this.processedObjects = new Set()

    // Check if the directory exists and is a git repository
    if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
      throw new Error(`${gitDir} does not appear to be a git repository`)
    }

    // Unpack the repository
    this.unpackRepository()
  }

  // Unpack all packed objects in the repository
  unpackRepository() {
    const packDir = path.join(this.objectsDir, "pack")
    if (!fs.existsSync(packDir)) {
      console.log("No pack directory found, skipping unpack step.")
      return
    }

    const packFiles = fs
      .readdirSync(packDir)
      .filter((file) => file.endsWith(".pack"))
      .map((file) => path.join(packDir, file))

    if (packFiles.length === 0) {
      console.log("No pack files found, skipping unpack step.")
      return
    }

    console.log(`Found ${packFiles.length} pack files, unpacking...`)

    // Run git commands from the repository's parent directory
    const repoRoot = path.dirname(this.gitDir)

    try {
      for (const packFile of packFiles) {
        console.log(`Unpacking ${path.basename(packFile)}...`)

        execSync(
          `mv ${packFile} . ; mv ${packFile.replace(".pack", ".idx")} .; git unpack-objects < "${packFile.replace(".git/objects/pack/", "")}"`,
          {
            cwd: repoRoot,
          },
        )
      }
      console.log("Repository unpacked successfully.")
    } catch (err) {
      console.warn(`Warning: Failed to unpack repository: ${err.message}`)
      console.warn(
        "Continuing with parsing, but some objects might be missing.",
      )
    }
  }

  // Main method to generate the Scroll file
  generateScrollFile() {
    // Find the HEAD commit and process it first to get a nicely ordered file
    const headCommit = this.getHeadCommit()
    if (headCommit) {
      this.processObject(headCommit)
    }

    // Add sections for different object types
    this.processAllObjects("commit")
    this.processAllObjects("tree")
    this.processAllObjects("blob")
    this.processAllObjects("tag")

    // Write the output to the file
    fs.writeFileSync(this.outputFile, this.output.join("\n"))
    console.log(`Generated Scroll file at ${this.outputFile}`)
  }

  // Get the current HEAD commit
  getHeadCommit() {
    try {
      return execSync("git rev-parse HEAD", { cwd: path.dirname(this.gitDir) })
        .toString()
        .trim()
    } catch (err) {
      console.warn("Could not determine HEAD commit:", err.message)
      return null
    }
  }

  // Process all objects of a specific type
  processAllObjects(type) {
    const dirs = fs.readdirSync(this.objectsDir)

    for (const dir of dirs) {
      // Skip info and pack directories
      if (dir === "info" || dir === "pack") continue

      const objectDir = path.join(this.objectsDir, dir)
      if (!fs.statSync(objectDir).isDirectory()) continue

      const files = fs.readdirSync(objectDir)
      for (const file of files) {
        const hash = dir + file
        this.processObject(hash, type)
      }
    }
  }

  // Process a single git object
  processObject(hash, requiredType = null) {
    // Skip if already processed
    if (this.processedObjects.has(hash)) return

    try {
      const object = this.readObject(hash)

      // Only process objects of the required type if specified
      if (requiredType && object.type !== requiredType) return

      this.processedObjects.add(hash)

      switch (object.type) {
        case "commit":
          this.formatCommit(hash, object.content)
          break
        case "tree":
          this.formatTree(hash, object.content)
          break
        case "blob":
          this.formatBlob(hash, object.content)
          break
        case "tag":
          this.formatTag(hash, object.content)
          break
      }
    } catch (err) {
      console.warn(`Error processing object ${hash}: ${err.message}`)
    }
  }

  // Read and decompress a git object
  readObject(hash) {
    const objectPath = path.join(
      this.objectsDir,
      hash.substring(0, 2),
      hash.substring(2),
    )

    if (!fs.existsSync(objectPath)) {
      throw new Error(`Object ${hash} not found`)
    }

    const compressed = fs.readFileSync(objectPath)
    const decompressed = zlib.inflateSync(compressed)

    // Parse the object header
    const nullIndex = decompressed.indexOf(0)
    const header = decompressed.slice(0, nullIndex).toString()
    const [type, size] = header.split(" ")

    // Extract the content
    const content = decompressed.slice(nullIndex + 1)

    return { type, size: parseInt(size), content }
  }

  // Format a commit object
  formatCommit(hash, content) {
    const contentStr = content.toString()
    const lines = contentStr.split("\n")

    this.appendLine(`commit ${hash}`)

    let messageStarted = false
    let messageLines = []

    for (const line of lines) {
      if (messageStarted) {
        messageLines.push(line)
      } else if (line === "") {
        messageStarted = true
      } else {
        const [key, ...valueParts] = line.split(" ")
        const value = valueParts.join(" ")
        this.appendLine(` ${key} ${value}`)
      }
    }

    if (messageLines.length > 0) {
      this.appendLine(` message ${messageLines[0]}`)
      if (messageLines.length > 1) {
        for (let i = 1; i < messageLines.length; i++) {
          this.appendLine(`  ${messageLines[i]}`)
        }
      }
    }

    this.appendLine("")
  }

  // Format a tree object
  formatTree(hash, content) {
    this.appendLine(`tree ${hash}`)

    let offset = 0
    while (offset < content.length) {
      // Find the null byte that separates mode and path
      let nullIndex = content.indexOf(0, offset)
      const modeAndPath = content.slice(offset, nullIndex).toString()

      // Split by the last space to get mode and path
      const lastSpaceIndex = modeAndPath.lastIndexOf(" ")
      const mode = modeAndPath.substring(0, lastSpaceIndex)
      const path = modeAndPath.substring(lastSpaceIndex + 1)

      // Read the SHA-1 hash (20 bytes)
      const sha = content.slice(nullIndex + 1, nullIndex + 21)
      const shaHex = sha.toString("hex")

      // Update offset for next entry
      offset = nullIndex + 21

      this.appendLine(
        ` ${mode} ${this.getTypeFromMode(mode)} ${shaHex} ${path}`,
      )
    }

    this.appendLine("")
  }

  // Format a blob object
  formatBlob(hash, content) {
    // Check if content is likely binary
    const isBinary = this.isBinaryContent(content)

    if (isBinary) {
      this.appendLine(`blob ${hash} base64`)
      this.appendLine(` ${content.toString("base64")}`)
    } else {
      this.appendLine(`blob ${hash}`)
      const contentStr = content.toString()
      const lines = contentStr.split("\n")

      for (const line of lines) {
        this.appendLine(` ${line}`)
      }
    }

    this.appendLine("")
  }

  // Format a tag object
  formatTag(hash, content) {
    const contentStr = content.toString()
    const lines = contentStr.split("\n")

    this.appendLine(`tag ${lines[0].split(" ")[1]}`)

    let messageStarted = false
    let messageLines = []

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]

      if (messageStarted) {
        messageLines.push(line)
      } else if (line === "") {
        messageStarted = true
      } else {
        const [key, ...valueParts] = line.split(" ")
        const value = valueParts.join(" ")
        this.appendLine(` ${key} ${value}`)
      }
    }

    if (messageLines.length > 0) {
      this.appendLine(` message ${messageLines[0]}`)
      if (messageLines.length > 1) {
        for (let i = 1; i < messageLines.length; i++) {
          this.appendLine(`  ${messageLines[i]}`)
        }
      }
    }

    this.appendLine("")
  }

  // Check if content is likely binary
  isBinaryContent(buffer) {
    // Check for null bytes or high concentration of non-printable characters
    const sampleSize = Math.min(buffer.length, 1000)
    let nonPrintable = 0

    for (let i = 0; i < sampleSize; i++) {
      const byte = buffer[i]
      if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) {
        nonPrintable++
      }
    }

    return nonPrintable > sampleSize * 0.1 || buffer.includes(0)
  }

  // Get object type from mode
  getTypeFromMode(mode) {
    const modeNum = parseInt(mode, 8)
    if ((modeNum & 0x4000) === 0x4000) {
      return "tree"
    } else {
      return "blob"
    }
  }

  // Append a line to the output
  appendLine(line) {
    this.output.push(line)
  }
}

// Main function
function main() {
  if (process.argv.length < 4) {
    console.error("Usage: node git-to-scroll.js <git-dir> <output-file>")
    process.exit(1)
  }

  const gitDir = path.join(process.argv[2], ".git")
  const outputFile = process.argv[3]

  try {
    const parser = new GitToScroll(gitDir, outputFile)
    parser.generateScrollFile()
  } catch (err) {
    console.error("Error:", err.message)
    process.exit(1)
  }
}

// Run the main function if this script is executed directly
if (require.main === module) {
  main()
}

module.exports = GitToScroll

#! /usr/bin/env node

// NPM ecosystem includes
const parseArgs = require("minimist")
const path = require("path")
const fs = require("fs")
const child_process = require("child_process")
const https = require("https")

// Particles Includes
const { Disk } = require("scrollsdk/products/Disk.node.js")
const { Particle } = require("scrollsdk/products/Particle.js")
const { SimpleCLI } = require("scroll-cli")
const packageJson = require("./package.json")
const { HistoryParticle, calculateCommitHash } = require("./HistoryParticle.js")
const { GitToSit } = require("./GitToSit.js")

const errorMessages = {
  noSit: (dir) => `'${dir}' is not a sit repository (no .sit file found).`,
  alreadySit: (filepath) => `Already .sit in this folder: '${filepath}'`,
}

class SitCLI extends SimpleCLI {
  welcomeMessage =
    `\n⛓️  Simple Information Tracker (v${packageJson.version})`.toUpperCase()

  log(message) {
    if (this.logs) this.logs.push(message)
    else console.log(message)
  }

  error(message) {
    if (this.errors) this.errors.push(message)
    else console.error(message)
  }

  silence() {
    this.logs = []
    this.errors = []
    return this
  }

  get output() {
    return this.logs.join("\n") + "\n" + this.errors.join("\n")
  }

  findHistoryFile(cwd) {
    // Check if directory exists
    if (!fs.existsSync(cwd)) return null

    try {
      // Get all entries in the directory
      const entries = fs.readdirSync(cwd, { withFileTypes: true })

      // Look for any file ending in .sit
      const historyFile = entries.find(
        (entry) => entry.isFile() && entry.name.endsWith(".sit"),
      )

      return historyFile ? path.join(cwd, historyFile.name) : null
    } catch (error) {
      this.error(`Error searching directory ${cwd}: ${error.message}`)
      return null
    }
  }

  loadHistoryParticle(cwd) {
    const historyFile = this.findHistoryFile(cwd)
    if (!historyFile) return null
    this.historyParticle = new HistoryParticle(
      Disk.read(historyFile),
      historyFile,
    )
    return this.historyParticle
  }

  initCommand(cwd) {
    const historyFile = this.findHistoryFile(cwd)
    if (historyFile) return this.error(errorMessages.alreadySit(historyFile))

    // Create initial commit content
    const timestamp = new Date().toISOString()
    const author = process.env.USER || "Unknown"
    const message = "Initial commit"

    // Calculate hash for initial commit (no parent, no changes)
    const hash = calculateCommitHash(author, timestamp, message)

    // Format initial commit
    const initialContent = `commit
 author ${author}
 timestamp ${timestamp}
 message ${message}
 order 1
 id ${hash}
`

    const newPath = this.makeHistoryFilePath(cwd)
    fs.writeFileSync(newPath, initialContent, "utf8")
    this.log(`Created '${newPath}'`)
  }

  makeHistoryFilePath(cwd) {
    const dirName = path.basename(cwd)
    return path.join(cwd, `${dirName}.sit`)
  }

  /*
  Let's work on the sit add command. I've given you a list of files to add,
  please figure out how to look at those files, and look at the file tree as
  it would exist in the .sit file, and then generate the necessary
  operations to go from that .sit to the current on disk tree, and
  then add those to the .sit file, ready to be committed*/
  async addCommand(cwd, files = []) {
    const historyParticle = this.loadHistoryParticle(cwd)
    if (!historyParticle) return this.error(errorMessages.noSit(cwd))
    if (!files.length) return this.error("No file paths provided to add.")

    const changes = historyParticle.addFiles(files)
    if (!changes.length) {
      this.log("No changes to add")
      return
    }
    const particle = new Particle(changes)
    this.log(`Added ${particle.length} change(s) to staging area`)
  }

  async resetCommand(cwd) {
    this.loadHistoryParticle(cwd).reset().save()
  }

  async statusCommand(cwd) {
    const historyParticle = this.loadHistoryParticle(cwd)
    if (!historyParticle) return this.error(errorMessages.noSit(cwd))

    const { stagedChanges, unstagedChanges } = historyParticle

    // Display status
    if (stagedChanges.length === 0) {
      this.log(`Stage is empty.`)
    } else {
      this.log(`\n${stagedChanges.length} staged change(s):\n`)
      stagedChanges.forEach((change, index) =>
        console.log(" " + (index + 1) + ". " + change.getLine()),
      )
    }

    this.log(`\n${unstagedChanges.length} unstaged change(s):\n`)
    if (unstagedChanges.length === 0) {
      this.log(" (working tree clean)")
    } else {
      unstagedChanges.forEach((change, index) => {
        this.log(`${change.path} (${change.type})`)
      })
    }
    this.log("\n")
  }

  async statsCommand(cwd) {
    const historyParticle = this.loadHistoryParticle(cwd)
    if (!historyParticle) return this.error(errorMessages.noSit(cwd))

    this.log(historyParticle.stats)
  }

  async commitCommand(cwd, message = []) {
    message = message.join(" ")
    const historyParticle = this.loadHistoryParticle(cwd)
    if (!historyParticle) return this.error(errorMessages.noSit(cwd))

    if (!historyParticle.stagedChanges.length)
      return this.error("No staged changes. Aborting commit.")

    const hash = historyParticle.addCommit(message)

    this.log(`[${hash.substring(0, 7)}] ${message || "No commit message"}`)
  }

  // pushCommand() {}
  // pullCommand() {}
  // sitToGitCommand() {}
  async cloneCommand(cwd, historyPaths) {
    if (historyPaths.length < 1) {
      this.error("Error: repo path required")
      return
    }

    for (let source of historyPaths) {
      try {
        await this.clone(cwd, source)
        this.log(`Successfully cloned '${source}'`)
      } catch (error) {
        this.error(`Clone failed: ${error.message}`)
      }
    }
  }

  async clone(cwd, source) {
    const parsed = path.parse(source)
    const destinationFolder = path.join(cwd, parsed.name)

    // Check if destinationFolder already exists
    if (fs.existsSync(destinationFolder)) {
      throw new Error(`Destination '${destinationFolder}' already exists`)
    }

    // Create destination directory
    fs.mkdirSync(destinationFolder)

    try {
      // Determine if source is URL or local path
      const isUrl =
        source.startsWith("http://") || source.startsWith("https://")
      const historyFile = path.join(destinationFolder, parsed.base)

      if (isUrl) {
        await this.downloadFile(source, historyFile)
      } else {
        // Handle local file
        if (!fs.existsSync(source)) {
          throw new Error(`Source '${source}' does not exist`)
        }
        fs.copyFileSync(source, historyFile)
      }

      // Replay history
      const historyParticle = this.loadHistoryParticle(destinationFolder)
      await historyParticle.checkoutLatestTo(destinationFolder)
    } catch (error) {
      // Clean up on failure
      fs.rmSync(destinationFolder, { recursive: true, force: true })
      throw error
    }
  }

  async downloadFile(url, destination) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destination)
      https
        .get(url, (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download: ${response.statusCode}`))
            return
          }

          response.pipe(file)
          file.on("finish", () => {
            file.close()
            resolve()
          })
        })
        .on("error", (error) => {
          fs.unlink(destination, () => reject(error))
        })
    })
  }

  async stashCommand(cwd) {
    const historyParticle = this.loadHistoryParticle(cwd)
    if (!historyParticle) return this.error(errorMessages.noSit(cwd))
    const stashed = historyParticle.stash()
    if (stashed.length) {
      historyParticle.save()
      this.log(`Stashed ${stashed.length} changes`)
    } else this.log(`No changes to stash.`)
  }

  async unstashCommand(cwd) {
    const historyParticle = this.loadHistoryParticle(cwd)
    if (!historyParticle) return this.error(errorMessages.noSit(cwd))
    historyParticle.unstash().save()
  }

  async checkoutCommand(cwd, query = []) {
    query = query.join(" ")
    const historyParticle = this.loadHistoryParticle(cwd)
    if (!historyParticle) return this.error(errorMessages.noSit(cwd))

    // Handle case with no arguments - fast forward to latest commit
    if (query.length === 0) {
      // No need to do anything, as stagedTree is already the latest state
      await historyParticle.applyCheckout(cwd)
      this.log(`Checked out to latest commit`)
      return
    }

    // Find the target commit based on the query
    const targetCommit = historyParticle.findTargetCommit(query)
    if (!targetCommit) {
      return this.error(`Could not find commit matching '${query}'`)
    }

    // Check for unstaged changes
    const unstaged = historyParticle.unstagedChanges
    if (unstaged.length > 0) {
      return this.error(
        `You have ${unstaged.length} unstaged changes. Please stash or commit them before checkout.`,
      )
    }

    // Get the commit tree up to the target commit
    const targetTree = historyParticle.getCommittedTreeUntil(
      (particle) => particle === targetCommit,
    )

    await historyParticle.applyCheckout(cwd, targetTree)

    const shortHash = targetCommit.get("id").substring(0, 7)
    this.log(`Checked out to commit ${shortHash}`)
  }

  lsCommand(cwd) {
    const historyParticle = this.loadHistoryParticle(cwd)
    if (!historyParticle) return this.error(errorMessages.noSit(cwd))
    console.log(Array.from(historyParticle.committedTree.keys()).join("\n"))
  }

  logCommand(cwd) {
    const historyParticle = this.loadHistoryParticle(cwd)
    if (!historyParticle) return this.error(errorMessages.noSit(cwd))
    console.log(historyParticle.toString())
  }

  diffCommand(cwd, files) {
    const historyParticle = this.loadHistoryParticle(cwd)
    if (!historyParticle) return this.error(errorMessages.noSit(cwd))
    const changes = historyParticle.diff(files || [])
    console.log(changes)
  }

  // verifyCommand() {}

  stageCommand(cwd) {
    const historyParticle = this.loadHistoryParticle(cwd)
    if (!historyParticle) return this.error(errorMessages.noSit(cwd))
    console.log(
      historyParticle.stagedChanges.map((p) => p.toString()).join("\n"),
    )
  }

  async fromGitCommand(cwd) {
    const outputFile = this.makeHistoryFilePath(cwd)
    const gts = new GitToSit()
    const start = Date.now()
    const converter = new GitToSit(cwd, (progress) => {
      // Example progress handler
      const elapsed = (Date.now() - start) / 1000
      const cps = (progress.current / elapsed).toFixed(2)
      console.log(
        `Processing commit ${progress.current}/${progress.total} (${progress.percentage}%) . ${cps} cps`,
      )
    })
    await converter.convert(outputFile)
    console.log(`Created '${outputFile}'.`)
  }

  async checkout(cwd, query) {
    const historyParticle = this.loadHistoryParticle(cwd)
    if (!historyParticle) return this.error(errorMessages.noSit(cwd))

    // If someone has unstaged changes, tell them to stash.

    // If query is an integer like 1, 10, 321, etc, then we should stop if the commit order is equal to that integer
    // If query is a hash (either full or just substring) like a12, we should do a comparison and stop if the hash of the commit includes the query

    const tree = historyParticle.getCommittedTreeUntil(fn)
    // Now that we have the tree as it should exist, write that to disk.
  }
}

if (module && !module.parent)
  new SitCLI().executeUsersInstructionsFromShell(
    parseArgs(process.argv.slice(2))._,
  )

module.exports = { SitCLI, HistoryParticle }

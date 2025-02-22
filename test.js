#! /usr/bin/env node

const tap = require("tap")
const fs = require("fs")
const path = require("path")
const os = require("os")
const { SitCLI } = require("./sit.js")
const { TestRacer } = require("scrollsdk/products/TestRacer.js")
const { execSync } = require("child_process")
const { GitToSit } = require("./GitToSit.js")
const { HistoryParticle } = require("./HistoryParticle.js")
const { Disk } = require("scrollsdk/products/Disk.node.js")

const testParticles = {}

// Helper function to create a temporary directory for tests
const createTempDir = () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sit-test-"))
  return tmpDir
}

const createTempTestDir = () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sit-test-"))
  execSync(`cp ${path.join(__dirname, "test")}/*.* ${tmpDir}`)
  return tmpDir
}

// Helper function to cleanup test directory
const cleanup = (dir) => {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

testParticles.initCommand = async (areEqual) => {
  // Setup
  const tmpDir = createTempDir()
  const cli = new SitCLI()

  try {
    // Test initial repository creation
    cli.initCommand(tmpDir)
    const historyFile = cli.findHistoryFile(tmpDir)

    areEqual(fs.existsSync(historyFile), true, ".sit file should be created")

    const content = fs.readFileSync(historyFile, "utf8")
    areEqual(
      content.includes("commit\n"),
      true,
      "history file should start with commit",
    )
    areEqual(
      content.includes(`author ${process.env.USER || "Unknown"}`),
      true,
      "should include author",
    )
    areEqual(content.includes("timestamp"), true, "should include timestamp")
    areEqual(
      content.includes("message Initial commit"),
      true,
      "should include commit message",
    )
    areEqual(content.includes("id"), true, "should include commit hash")

    cli.silence()
    // Test re-initialization (should fail)
    cli.initCommand(tmpDir)
    areEqual(
      cli.output.includes("Already"),
      true,
      "should prevent re-initialization",
    )
  } finally {
    cleanup(tmpDir)
  }
}

testParticles.statusCommand = async (areEqual) => {
  const tmpDir = createTempDir()
  const cli = new SitCLI().silence()

  try {
    // Test status on non-repository
    cli.statusCommand(tmpDir)
    areEqual(
      cli.output.includes("not a sit repository"),
      true,
      "should indicate not a repository",
    )

    // Test status on empty repository
    cli.silence()
    cli.initCommand(tmpDir)
    cli.statusCommand(tmpDir)
    const historyParticle = cli.loadHistoryParticle(tmpDir)

    areEqual(historyParticle.stagedChanges.length, 0, "should be no changed")
    areEqual(
      historyParticle.unstagedChanges.length,
      0,
      "should be no unstaged changed",
    )
  } finally {
    cleanup(tmpDir)
  }
}

testParticles.addCommand = async (areEqual) => {
  const tmpDir = createTempDir()
  const cli = new SitCLI().silence()

  try {
    // Test add on non-repository
    cli.addCommand(tmpDir)
    areEqual(
      cli.output.includes("no .sit file found"),
      true,
      "should indicate not a repository",
    )

    // Test add on empty repository
    cli.silence()
    cli.initCommand(tmpDir)
    const historyParticle = cli.loadHistoryParticle(tmpDir)
    const changes = historyParticle.addFiles([])

    areEqual(changes.length, 0, "should indicate no changes to add")
  } finally {
    cleanup(tmpDir)
  }
}

testParticles.basicFlows = async (areEqual) => {
  const cwd = createTempTestDir()
  const cli = new SitCLI().silence()
  let historyParticle

  try {
    // Act
    await cli.initCommand(cwd)
    await cli.addCommand(cwd, ["favicon.ico"])
    historyParticle = cli.loadHistoryParticle(cwd)

    // Assert
    areEqual(historyParticle.stagedChanges.length, 1, "one staged change")

    // Act
    await cli.addCommand(cwd, ["package.json"])
    historyParticle = cli.loadHistoryParticle(cwd)

    // Assert
    areEqual(historyParticle.stagedChanges.length, 2, "2 staged changes")
    areEqual(
      historyParticle.unstagedChanges.length,
      0,
      "should be no unstaged changes",
    )

    // Act
    await cli.commitCommand(cwd)
    historyParticle = cli.loadHistoryParticle(cwd)

    // Assert
    areEqual(historyParticle.commitCount, 2, "should be 2 commits")

    // Act
    await cli.checkoutCommand(cwd, ["1"])
    // Assert
    const iconPath = path.join(cwd, "favicon.ico")
    areEqual(
      Disk.exists(iconPath),
      false,
      "going back in time erases a tracked file",
    )

    // Act
    await cli.checkoutCommand(cwd)
    areEqual(
      Disk.exists(iconPath),
      true,
      "going forward in time restores tracked file",
    )
  } finally {
    cleanup(cwd)
  }
}

testParticles.gitToSitCommand = async (areEqual) => {
  // Arrange
  const cwd = createTempTestDir()
  const outputFile = path.join(cwd, "temp.sit")
  const jsonFile = path.join(cwd, "package.json")
  const original = Disk.read(jsonFile)
  try {
    // Act
    execSync(
      "rm -rf .git; git init; git add favicon.ico; git commit -m 'Initial commit'; git add package.json; git commit -m 'Added package.json';",
      {
        cwd,
      },
    )
    const modified = JSON.parse(original)
    modified.version = "0.2.0"
    Disk.write(jsonFile, JSON.stringify(modified, null, 2))
    execSync("git add package.json; git commit -m 'update version';", {
      cwd,
    })
    execSync(
      "mv package.json old.json; git add *.json; git commit -m 'move file';",
      {
        cwd,
      },
    )
    execSync("rm old.json; git add old.json; git commit -m 'remove file';", {
      cwd,
    })

    const gts = new GitToSit()
    const converter = new GitToSit(cwd, (progress) => {})
    await converter.convert(outputFile)
    const historyParticle = new HistoryParticle(
      Disk.read(outputFile),
      outputFile,
    )

    // Assert
    areEqual(historyParticle.commitCount, 5)
  } finally {
    // Cleanup
    execSync("rm -rf .git;", {
      cwd,
    })
    Disk.write(jsonFile, original)
  }
}

testParticles.checkoutCommand = async (areEqual) => {
  return
  // Setup
  const tmpDir = createTempDir()
  const cli = new SitCLI().silence()

  try {
    // Initialize repository
    cli.initCommand(tmpDir)

    // Create test files
    const file1Path = path.join(tmpDir, "file1.txt")
    const file2Path = path.join(tmpDir, "file2.txt")
    const dirPath = path.join(tmpDir, "testdir")
    const nestedFilePath = path.join(dirPath, "nested.txt")

    fs.writeFileSync(file1Path, "File 1 content", "utf8")

    // Add and commit first file
    cli.silence()
    cli.addCommand(tmpDir, ["file1.txt"])
    cli.commitCommand(tmpDir, ["First commit"])

    // Create and add second file and directory
    fs.mkdirSync(dirPath)
    fs.writeFileSync(file2Path, "File 2 content", "utf8")
    fs.writeFileSync(nestedFilePath, "Nested file content", "utf8")

    cli.silence()
    cli.addCommand(tmpDir, ["file2.txt", "testdir"])
    cli.commitCommand(tmpDir, ["Second commit"])

    // Get commit information
    const historyParticle = cli.loadHistoryParticle(tmpDir)
    const commits = historyParticle.commits
    areEqual(commits.length, 3, "Should have 3 commits (including initial)")

    const firstCommitId = commits[0].get("id")
    const secondCommitId = commits[1].get("id")
    const thirdCommitId = commits[2].get("id")

    // Modify file1.txt
    fs.writeFileSync(file1Path, "Modified content", "utf8")

    // Test checkout to first commit
    cli.silence()
    cli.checkoutCommand(tmpDir, [firstCommitId.substring(0, 7)])

    // Verify state after checkout
    areEqual(fs.existsSync(file1Path), true, "file1.txt should exist")
    areEqual(fs.existsSync(file2Path), false, "file2.txt should not exist")
    areEqual(fs.existsSync(dirPath), false, "testdir should not exist")
    areEqual(
      fs.readFileSync(file1Path, "utf8"),
      "File 1 content",
      "file1.txt should have original content",
    )

    // Create an untracked file
    const untrackedPath = path.join(tmpDir, "untracked.txt")
    fs.writeFileSync(untrackedPath, "Untracked content", "utf8")

    // Test checkout to second commit
    cli.silence()
    cli.checkoutCommand(tmpDir, [secondCommitId.substring(0, 7)])

    // Verify state after checkout
    areEqual(fs.existsSync(file1Path), true, "file1.txt should exist")
    areEqual(fs.existsSync(file2Path), true, "file2.txt should exist")
    areEqual(fs.existsSync(dirPath), true, "testdir should exist")
    areEqual(fs.existsSync(nestedFilePath), true, "nested.txt should exist")
    areEqual(
      fs.existsSync(untrackedPath),
      true,
      "untracked.txt should still exist",
    )

    // Check content of files
    areEqual(
      fs.readFileSync(file1Path, "utf8"),
      "File 1 content",
      "file1.txt should have original content",
    )
    areEqual(
      fs.readFileSync(file2Path, "utf8"),
      "File 2 content",
      "file2.txt should have original content",
    )
    areEqual(
      fs.readFileSync(nestedFilePath, "utf8"),
      "Nested file content",
      "nested.txt should have original content",
    )
    areEqual(
      fs.readFileSync(untrackedPath, "utf8"),
      "Untracked content",
      "untracked.txt should be unchanged",
    )

    // Test checkout with no parameters (latest commit)
    cli.silence()
    cli.checkoutCommand(tmpDir, [])

    // Verify state after checkout to latest
    areEqual(fs.existsSync(file1Path), true, "file1.txt should exist")
    areEqual(fs.existsSync(file2Path), true, "file2.txt should exist")
    areEqual(fs.existsSync(dirPath), true, "testdir should exist")
    areEqual(fs.existsSync(nestedFilePath), true, "nested.txt should exist")
    areEqual(
      fs.existsSync(untrackedPath),
      true,
      "untracked.txt should still exist",
    )

    // Test checkout by order
    cli.silence()
    cli.checkoutCommand(tmpDir, ["1"]) // First commit by order

    // Verify state after checkout by order
    areEqual(fs.existsSync(file1Path), true, "file1.txt should exist")
    areEqual(fs.existsSync(file2Path), false, "file2.txt should not exist")
    areEqual(fs.existsSync(dirPath), false, "testdir should not exist")
  } finally {
    cleanup(tmpDir)
  }
}

if (module && !module.parent)
  TestRacer.testSingleFile(__filename, testParticles)

module.exports = { testParticles }

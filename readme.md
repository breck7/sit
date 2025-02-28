Sit: Simple Information Tracker
===============================

Sit is a new research prototype to explore an alternative to Git which stores project changes using a Particle Chain (a single append-only plain text file in Particle Syntax).

With Sit we will attempt to implement all major features of Git on top of a Particle Chain.

Very little currently works, but you can try the *alpha* demo with:

```
git clone https://github.com/breck7/sit
cd sit
npm install -g .
sit
```

Demo
====

```
> mkdir rocket
> cd rocket 
> sit init
@ Created '/Users/breck/rocket/rocket.sit'
> echo "# The Rocket Project" > readme.scroll
> sit status
@ Stage is empty.
@ 1 unstaged change(s):
@ readme.scroll (write)
> sit add .
@ Added 1 change(s) to staging area
> sit commit Added readme
@ [2963cb7] Added readme
> cat rocket.sit
@ commit
@  author breck
@  timestamp 2025-02-22T14:21:25.549Z
@  message Initial commit
@  order 1
@  id b5b8f402b159fe93a5fe900302ab2abc7cf94d92
@ write readme.scroll 0e7fac1b84734357a8d737fa1670b314f3031b34
@  # The Rocket Project
@  
@ commit
@  author breck
@  timestamp 2025-02-22T14:22:36.718Z
@  order 2
@  message Added readme
@  parent b5b8f402b159fe93a5fe900302ab2abc7cf94d92
@  id 2963cb754812de4afda816926bf78db91cb53a1f

```

Why?
====

Our aim is not to replace git or to improve version control, we are interested in exploring Particle Chains and applying what we learn with Sit to build a new kind of public ledger on Particle Chains.

We bet that the greater _visibility_ of Particle Chains may lead to more trustworthy and user-friendly blockchains.

If Sit turns out to be better than Git for some VCS use cases that will be a side benefit.

What is a Particle Chain?
=========================

A Particle chain is a sequence of alternating change and commit objects all encoded in Particle Syntax.
 https://scroll.pub/particlesLeetsheet.html Particle Syntax

A Particle chain can store any type of data in plain text without any visible escaping.

How it works
============

Blockchains can all be thought of as a sequence of tree change objects, cryptographically connected to each other by commitment objects.

Sit includes an expandable grammar of these tree change operations that can represent, with varying degrees of efficiency, all operations one might do to change a tree.

As a user modifies the tree, Sit turns these operations into Change Particles which are appended to the History file.

When the user is satisfied with the set of operations representing a transaction, a commit particle is then added to the history file.

The commit particle contains the hash of the parent commit, the hash of the tree from applying the set of operations, and can contain other metadata such as crytographic signatures and timestamp information.

The Particle Chain can also be called the History Particle of a tree.

FAQ
===

Won't this be terribly slow compared to git?
============================================

Git's object based storage model allows you to check out any checkpoint in constant time.

The initial implementation of Sit uses a diff based approach which requires replaying the commit history to checkout a specific checkpoint.

A simple way to make Sit fast for larger chains would be to add a command to generate a content-addressable index in a ".sit" folder.

What are some useful things people might do with Particle Chains?
=================================================================

One can imagine lots of innovations built on top of Particle Chain, such as: encoding bounties for the addition of useful scientific information, election software or government transaction registries.

What will be some useful parsers for Particle Chains?
=====================================================

Good question! This is the type of thing we will discover as we develop this prototype. 

Should hashes take as input the change objects, the current tree state, or a combination of both?
=================================================================================================

Good question! This is the type of thing we will discover as we develop this prototype.

In addition to change and commit objects, should other types of objects, such as comment objects, be allowed?
=============================================================================================================

Good question! This is the type of thing we will discover as we develop this prototype.

Could Particle Chains support change objects that extend the grammar of the Particle Chain itself?
==================================================================================================

Yes! This is the type of thing we will explore as we develop this prototype.

Should Particle Chains support file imports?
============================================

Probably! This is the type of thing we will discover as we develop this prototype.

What might a Particle Chain look like for a cryptocurrency?
===========================================================

Perhaps something like this:

```
write transaction/1
 amount 2.0
 from a
 to b
write wallets/b
 balance 2.0
write wallets/a
 balance 1.0
commit
 signed aSig123
 signature bSig234
```

Or this:

```
transaction 1
 amount 2.0
 from a
 to b
commit
 signatures aSig123 bSig123
```

How do I get involved?
======================

I am currently putting together a team of cofounders and investors to build the world's first cryptocurrency built on Particle Chains. If you are interested, shoot me an email breck7@gmail.com or DM me on X.
 https://twitter.com/breckyunits X

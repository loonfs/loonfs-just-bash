# loonfs-just-bash

A sandboxed workspace shell for operating on a durable, revisioned LoonFS
namespace. It uses familiar shell syntax but is not a POSIX filesystem.

`/workspace` is backed by one LoonFS namespace and is durable and revisioned.
`/tmp` and other scratch paths are ephemeral and in-memory. Symlinks, hard
links, permission enforcement, mutable file handles, and cheap append are
unsupported and fail explicitly rather than pretending to work.

Status: pre-release. The package currently ships the backend port and a
deterministic fake backend; the shell itself lands in later changes.

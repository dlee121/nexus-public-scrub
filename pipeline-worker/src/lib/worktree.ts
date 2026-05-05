import { spawnSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { basename, dirname, join } from 'path';

const WORKTREE_BASE = process.env.FORGE_WORKTREE_BASE ?? '/tmp/forge-worktrees';

// Same identity cc-priv.ts drops the CC subprocess to. Kept in sync manually
// — both files live in the same lib dir and would consolidate cleanly if a
// third caller ever needed the same drop.
const UBUNTU_UID = 1000;
const UBUNTU_GID = 1000;

export function createWorktree(repoPath: string, ticketId: string, baseBranch: string): string {
  const branchName = `forge/${ticketId.toLowerCase()}`;
  // Namespace the worktree path by the owning repo. Every Forge plan uses
  // ticketId "TKT-001", so without per-repo scoping a stale worktree from
  // repo A blocks repo B's run: cleanup via `git worktree remove` rejects
  // the path with "not a working tree" (different repo's admin metadata),
  // then `git worktree add` fails on the existing dir.
  const repoName = basename(repoPath);
  const worktreePath = join(WORKTREE_BASE, repoName, ticketId);
  mkdirSync(dirname(worktreePath), { recursive: true });
  // A prior crashed run may have left the worktree dir, the branch, or both.
  // Attempt each cleanup independently and ignore failures.
  spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath });
  spawnSync('git', ['branch', '-D', branchName], { cwd: repoPath });
  spawnSync('git', ['worktree', 'prune'], { cwd: repoPath });
  // Force-clean the leaf if it survived the git-side cleanup (orphaned by a
  // crash; the git remove above is a no-op when admin metadata is missing).
  rmSync(worktreePath, { recursive: true, force: true });
  const fetchResult = spawnSync('git', ['fetch', 'origin'], { cwd: repoPath, stdio: 'inherit' });
  if (fetchResult.status !== 0) throw new Error(`git fetch failed for worktree setup (ticket: ${ticketId})`);
  const result = spawnSync('git', ['worktree', 'add', '-b', branchName, worktreePath, `origin/${baseBranch}`], { cwd: repoPath, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`git worktree add failed for ${ticketId}`);

  // The CC subprocess runs as ubuntu (see cc-priv.ts) and writes throughout
  // the parent repo's .git tree on every commit/stash/rebase: per-worktree
  // index/HEAD locks under .git/worktrees/<id>/, branch ref locks under
  // .git/refs/heads/<prefix>/, FETCH_HEAD, packed-refs, etc. `git worktree add`
  // ran as root so the new dirs (.git/worktrees/, .git/refs/heads/forge/) are
  // root-owned; a recursive chown of the whole .git is the safe, fix-once-and-
  // forget answer. Root keeps full access regardless of ownership, and the
  // repo is a transient pipeline asset. Only meaningful when the worker is
  // root — skipped silently otherwise (dev / test).
  if (process.geteuid?.() === 0) {
    spawnSync('chown', ['-R', `${UBUNTU_UID}:${UBUNTU_GID}`, join(repoPath, '.git')]);
  }

  return worktreePath;
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
  spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath, stdio: 'inherit' });
}

export function getBranchName(ticketId: string): string {
  return `forge/${ticketId.toLowerCase()}`;
}

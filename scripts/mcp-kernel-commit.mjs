#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

function parseArgs(args) {
  const result = {
    message: '',
    objective: '',
    project: '',
    verification: '',
    push: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-m' || arg === '--message') {
      result.message = args[++i] || '';
    } else if (arg === '-o' || arg === '--objective') {
      result.objective = args[++i] || '';
    } else if (arg === '-p' || arg === '--project') {
      result.project = args[++i] || '';
    } else if (arg === '-v' || arg === '--verification') {
      result.verification = args[++i] || '';
    } else if (arg === '--push') {
      result.push = true;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    }
  }
  return result;
}

function runGit(repoRoot, gitArgs, options = {}) {
  return execFileSync('git', gitArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

function findRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (current) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

const DENIED_PATTERNS = [
  /^\.env/i,
  /\/\.env/i,
  /^\.codex\/state\//i,
  /\.sqlite$/i,
  /\.db$/i,
  /^\.history\//i,
  /\/\.history\//i,
];

function isPathDenied(filePath) {
  const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  return DENIED_PATTERNS.some((pattern) => pattern.test(normalized));
}

function formatKernelMessage({ message, objective, project, verification, selectedPaths, push }) {
  const clean = String(message || '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  const lines = clean ? clean.split('\n') : [];
  const firstLineIdx = lines.findIndex((l) => l.trim());
  const subject = firstLineIdx >= 0
    ? lines[firstLineIdx].trim().slice(0, 96)
    : (objective ? `feat(kernel): ${objective.slice(0, 80)}` : `chore(kernel): ${project} 작업 반영`);
  const body = firstLineIdx >= 0 ? lines.slice(firstLineIdx + 1).join('\n').trim() : '';

  const msgParts = [subject, ''];

  if (body) {
    msgParts.push('요청 메시지:', body, '');
  }

  msgParts.push('Kernel 작업:');
  if (objective) {
    msgParts.push(`- 작업 목표: ${objective}`);
  }
  if (project) {
    msgParts.push(`- 프로젝트: ${project}`);
  }
  msgParts.push('- 완료 판정: 승인됨');
  msgParts.push(`- Git 마감: ${push ? '커밋 및 푸시' : '커밋'}`);
  if (verification) {
    msgParts.push(`- 검증 참조: ${verification}`);
  }

  msgParts.push('', `변경 경로 (${selectedPaths.length}):`);
  if (selectedPaths.length > 0) {
    for (const p of selectedPaths.slice(0, 80)) {
      msgParts.push(`- ${p}`);
    }
    if (selectedPaths.length > 80) {
      msgParts.push(`- ... ${selectedPaths.length - 80} 추가 경로`);
    }
  } else {
    msgParts.push('- 없음');
  }

  return msgParts.join('\n').trim() + '\n';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    console.error('Error: Not inside a Git repository.');
    process.exit(1);
  }

  const projectName = opts.project || path.basename(repoRoot);

  // Check git status
  const statusRaw = runGit(repoRoot, ['status', '--porcelain=v1']);
  const statusLines = statusRaw.split(/\r?\n/).filter(Boolean);

  const selectedPaths = [];
  const deniedPaths = [];

  for (const line of statusLines) {
    let filePath = line.slice(3).trim();
    if (filePath.includes(' -> ')) filePath = filePath.split(' -> ').pop().trim();
    if ((filePath.startsWith('"') && filePath.endsWith('"')) || (filePath.startsWith("'") && filePath.endsWith("'"))) {
      filePath = filePath.slice(1, -1);
    }
    const normalized = filePath.replaceAll('\\', '/');
    if (isPathDenied(normalized)) {
      deniedPaths.push(normalized);
    } else {
      selectedPaths.push(normalized);
    }
  }

  if (selectedPaths.length === 0) {
    console.log('No stagable changes found. Nothing to commit.');
    return;
  }

  const commitMessage = formatKernelMessage({
    message: opts.message,
    objective: opts.objective,
    project: projectName,
    verification: opts.verification,
    selectedPaths,
    push: opts.push,
  });

  if (opts.dryRun) {
    console.log('--- DRY RUN COMMIT MESSAGE ---');
    console.log(commitMessage);
    console.log('--- STAGED PATHS ---');
    console.log(selectedPaths.join('\n'));
    if (deniedPaths.length > 0) {
      console.log('--- DENIED PATHS ---');
      console.log(deniedPaths.join('\n'));
    }
    return;
  }

  // Stage selected paths
  runGit(repoRoot, ['add', '--', ...selectedPaths]);

  // Commit with message via stdin to ensure clean UTF-8 multiline preservation
  runGit(repoRoot, ['commit', '-F', '-'], { input: commitMessage });

  const commitHash = runGit(repoRoot, ['rev-parse', 'HEAD']).trim();
  console.log(`[Kernel Commit Success] ${commitHash}`);
  console.log(commitMessage);

  if (opts.push) {
    console.log('Pushing to remote origin...');
    runGit(repoRoot, ['push']);
    console.log('Push completed successfully.');
  }
}

main().catch((err) => {
  console.error('Kernel commit failed:', err.message);
  process.exit(1);
});

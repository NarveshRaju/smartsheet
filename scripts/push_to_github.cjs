/**
 * Helper script to push this repository to GitHub
 * Usage:
 *   node scripts/push_to_github.cjs <GITHUB_PERSONAL_ACCESS_TOKEN>
 * Or run standard git command in your terminal:
 *   git push -u origin main
 */
const fs = require('fs');
const path = require('path');
const http = require('isomorphic-git/http/node');
const git = require('isomorphic-git');

const dir = path.resolve(__dirname, '..');
const token = process.argv[2] || process.env.GITHUB_TOKEN;

if (!token) {
  console.log('----------------------------------------------------');
  console.log('📌 To push to GitHub using this script:');
  console.log('   node scripts/push_to_github.cjs <YOUR_GITHUB_TOKEN>');
  console.log('\nOr if you have Git installed in your terminal, run:');
  console.log('   git push -u origin main');
  console.log('----------------------------------------------------');
  process.exit(0);
}

async function push() {
  console.log('Pushing main branch to https://github.com/NarveshRaju/smartsheet.git ...');
  const pushResult = await git.push({
    fs,
    http,
    dir,
    remote: 'origin',
    ref: 'main',
    force: true,
    onAuth: () => ({ username: token }),
  });
  console.log('✅ Successfully pushed to GitHub!', pushResult);
}

push().catch(err => {
  console.error('❌ Push failed:', err.message);
  process.exit(1);
});

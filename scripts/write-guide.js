/**
 * Writes docs/assistant-guide.md: the guide for AI assistants exactly as the app writes it into the Google Doc
 * "Focus Tracker – guide for AI assistants" (src/core/guide.js), so a fresh agent can be tried against it without Google.
 * Runs the real server code on the in-memory fakes from tests/mocks.js, with the modes from src/core/config.js only and
 * no Doc yet, so the file holds no one's data. tests/server.test.js fails when the file is out of date.
 *
 *   node scripts/write-guide.js           write the file
 *   node scripts/write-guide.js --check   exit 1 if the file is out of date
 */
const fs = require('fs');
const path = require('path');
const { loadServer } = require('../tests/mocks');

const OUT = path.join(__dirname, '..', 'docs', 'assistant-guide.md');

function generatedGuide() {
  return String(loadServer().run('guideMarkdown_()'));
}

if (require.main === module) {
  const text = generatedGuide();
  if (process.argv.includes('--check')) {
    const same = fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === text;
    console.log(same ? 'docs/assistant-guide.md is up to date' : 'docs/assistant-guide.md is out of date: run node scripts/write-guide.js');
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(OUT, text);
  console.log('Wrote docs/assistant-guide.md (' + text.length + ' characters)');
}

module.exports = { generatedGuide, OUT };

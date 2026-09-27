const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

console.log('🔍 Scanning public/index.html for DOM elements, IDs, and event handlers...');

// 1. Extract all id="..."
const idMatches = [...html.matchAll(/id=["']([^"']+)["']/g)].map(m => m[1]);
const idSet = new Set(idMatches);
console.log(`✅ Found ${idSet.size} unique DOM IDs defined in HTML.`);

// 2. Extract getElementById calls
const getElementMatches = [...html.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(m => m[1]);
const missingIds = [];
for (const id of getElementMatches) {
  if (!idSet.has(id)) {
    missingIds.push(id);
  }
}

const uniqueMissingIds = [...new Set(missingIds)];
if (uniqueMissingIds.length > 0) {
  console.warn('⚠️ Found getElementById calls referencing non-existent IDs:', uniqueMissingIds);
} else {
  console.log('✅ All getElementById calls match existing DOM elements!');
}

// 3. Extract event handlers
const handlerMatches = [...html.matchAll(/on(?:click|change|submit|input)=["']([a-zA-Z0-9_]+)\(/g)].map(m => m[1]);
const missingFuncs = [];
for (const fn of handlerMatches) {
  if (['event', 'alert', 'confirm', 'parseInt', 'parseFloat', 'encodeURIComponent'].includes(fn)) continue;
  const regex = new RegExp(`(?:function\\s+${fn}\\b|\\b${fn}\\s*=\\s*(?:function|\\([^)]*\\)\\s*=>))`);
  if (!regex.test(html)) {
    missingFuncs.push(fn);
  }
}

const uniqueMissingFuncs = [...new Set(missingFuncs)];
if (uniqueMissingFuncs.length > 0) {
  console.warn('⚠️ Found inline event handlers calling non-existent functions:', uniqueMissingFuncs);
} else {
  console.log('✅ All inline HTML event handlers correspond to defined JavaScript functions!');
}

// 4. Check for unclosed script or style tags
const openScripts = (html.match(/<script\b/gi) || []).length;
const closeScripts = (html.match(/<\/script>/gi) || []).length;
console.log(`Scripts: ${openScripts} opened, ${closeScripts} closed.`);
if (openScripts !== closeScripts) {
  console.error('❌ Mismatched <script> tags!');
} else {
  console.log('✅ <script> tags balanced.');
}

console.log('🏁 Scanner finished.');

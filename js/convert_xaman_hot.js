// tools/convert_xaman_hot.js
// Usage: node tools/convert_xaman_hot.js "AAAAAA BBBBBB CCCCCC DDDDDD EEEEEE FFFFFF GGGGGG HHHHHH"
import { Account } from 'xrpl-secret-numbers';

const input = (process.argv.slice(2).join(' ') || '').trim();
if (!input) {
  console.log('Usage:\n  node tools/convert_xaman_hot.js "123456 234567 345678 456789 567890 678901 789012 890123"');
  process.exit(1);
}

// Normalize whitespace/newlines into single spaces:
const secretNumbers = input.replace(/\s+/g, ' ');
try {
  const acct = new Account(secretNumbers);
  const familySeed = acct.getFamilySeed(); // -> sXXXXXXXXXXXXXXXX
  const address = acct.getAddress();       // -> rXXXXXXXXXXXXXXXX

  console.log('Derived address:', address);
  console.log('Family Seed   :', familySeed);
  console.log('\n➡ Verify the address matches your HOT wallet (r...).');
  console.log('   Then set HOT_SEED to the family seed on Render.\n');
} catch (e) {
  console.error('Conversion failed:', e.message);
  process.exit(1);
}

/**
 * Test suite for isGibberishSender_ and shannonEntropy_.
 * Can be run directly inside the Google Apps Script editor (`runGibberishTests`)
 * or locally via Node.js (`node test_gibberish.js`).
 */

if (typeof isGibberishSender_ === 'undefined' && typeof require !== 'undefined') {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const code = fs.readFileSync(path.join(__dirname, 'smart_gmail_filter.gs'), 'utf8');
  vm.runInThisContext(code);
}

function runGibberishTests() {
  const cases = [
    // Legitimate senders (should NOT be flagged as spam)
    { from: 'GitHub <noreply@github.com>', expected: false, desc: 'Standard brand domain' },
    { from: 'Google Alerts <googlealerts-noreply@google.com>', expected: false, desc: 'Hyphenated local part' },
    { from: 'Billing <invoice+12345@stripe.com>', expected: false, desc: 'Plus addressing' },
    { from: 'Support <help@mail.company.co.uk>', expected: false, desc: '4-part country-code SLD' },
    { from: 'Jane Doe <jane.doe@sub.example.org>', expected: false, desc: 'Standard subdomain' },
    { from: 'no-reply@accounts.google.com', expected: false, desc: 'Bare email address' },
    { from: 'Invalid Header Without Email', expected: false, desc: 'Unparseable header fallback' },

    // Gibberish / spam senders (grouped by domain TLD/SLD)
    // .me
    { from: 'coiexjr.104.767934@liawfofb.uqsoa.lorimir.me', expected: true, desc: '.me multi-subdomain + tracking ID' },
    { from: 'rcusmwb.104.767934@klbobflp.toti.naleren.me', expected: true, desc: '.me multi-subdomain + tracking ID' },

    // .biz
    { from: 'mjxwxfs.104.767934@nwrygvkt.sousintree.sufijunir.biz', expected: true, desc: '.biz multi-subdomain + consonant clusters' },
    { from: 'ndunlbs.104.767934@twqptspz.cocouriea.xelviora.biz', expected: true, desc: '.biz multi-subdomain + phonotactic q without u' },

    // .my.id
    { from: 'ftgwqae.104.767934@muzxdqqe.helplink.tiawut.my.id', expected: true, desc: '.my.id deep subdomain + bigrams' },
    { from: 'flaabsa.104.767934@tetmmljk.fermin.sidemu.my.id', expected: true, desc: '.my.id deep subdomain + consonant cluster' },

    // .web.id
    { from: 'dbonkde.104.767934@wymxrjky.maineto.varerovilo.web.id', expected: true, desc: '.web.id multi-subdomain + tracking ID' },
    { from: 'dkonflq.104.767934@lecobfad.rainko.sileninela.web.id', expected: true, desc: '.web.id deep subdomain + tracking ID' },
    { from: 'pdzptnu.104.767934@akszzbss.hyperl.assetcenter.web.id', expected: true, desc: '.web.id deep subdomain + consonant clusters' },

    // Via / Return-Path relay spoofing
    {
      from: 'Cloud.Notice. <nooreply@ldeqsdosisg.us>',
      returnPath: '<bounces@google-apple-amazon.chelsea.uk.com.mptcristales.cl>',
      expected: true,
      desc: 'Via / Return-Path relay domain triggers spam'
    }
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const res = evaluateSenderIdentity_(tc.from, tc.returnPath, tc.sender);
    if (res.isSpam === tc.expected) {
      passed++;
    } else {
      failed++;
      console.error(
        `FAIL: ${tc.desc}\n  Input:    ${tc.from}\n  Expected: isSpam=${tc.expected}\n  Actual:   isSpam=${res.isSpam} (${res.reason})`
      );
    }
  }

  console.log(`Tests: ${passed}/${cases.length} passed.`);
  if (failed > 0 && typeof process !== 'undefined') {
    process.exit(1);
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  runGibberishTests();
}

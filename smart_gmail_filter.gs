const CONFIG = {
  GEMINI_MODEL: 'gemini-3.8-flash',
  REVIEWED_LABEL: 'AI-Reviewed',
  BATCH_SIZE: 10,
  NEWER_THAN: '7d',
  SPAM_THRESHOLD: 70,
};

/**
 * Main entry point — runs on both Inbox (via Gemini) and Spam (via deterministic gibberish filter).
 */
function processUnreadEmails() {
  const label = getOrCreateLabel_(CONFIG.REVIEWED_LABEL);

  // 1. Scan Spam folder deterministically (no AI calls needed)
  processSpamFolder_(label);

  // 2. Scan Inbox using Gemini API
  processInboxFolder_(label);
}

/**
 * Scans unread emails in Spam:
 * - If sender is gibberish/unreadable -> moves thread to Trash
 * - Otherwise -> leaves unread and applies REVIEWED_LABEL so it isn't checked again
 */
function processSpamFolder_(label) {
  const query = `in:spam is:unread -label:${CONFIG.REVIEWED_LABEL}`;
  const threads = GmailApp.search(query, 0, CONFIG.BATCH_SIZE);

  for (const thread of threads) {
    const messages = thread.getMessages();
    const msg = messages[messages.length - 1];
    const from = msg.getFrom();
    const returnPath = msg.getHeader('Return-Path');
    const sender = msg.getHeader('Sender');

    const verdict = evaluateSenderIdentity_(from, returnPath, sender, CONFIG.SPAM_THRESHOLD);

    thread.addLabel(label);
    if (verdict.isSpam) {
      const detail = verdict.sourceHeader === 'From' ? from : `${from} [${verdict.sourceHeader}: ${verdict.rawValue}]`;
      console.log(`[Spam -> TRASH] ${detail} (${verdict.reason})`);
      thread.markRead();
      thread.moveToTrash();
    }
  }
}

/**
 * Scans unread emails in Inbox using Gemini API.
 */
function processInboxFolder_(label) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY in Script Properties.');

  const query = `in:inbox is:unread -label:${CONFIG.REVIEWED_LABEL} newer_than:${CONFIG.NEWER_THAN}`;
  const threads = GmailApp.search(query, 0, CONFIG.BATCH_SIZE);

  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    const messages = thread.getMessages();
    const msg = messages[messages.length - 1];
    const subject = msg.getSubject() || '(no subject)';

    const evaluation = evaluateEmailWithGemini_(msg, apiKey);

    thread.addLabel(label);
    if (evaluation.verdict === 'NOT_IMPORTANT') {
      console.log(`[Inbox -> NOT_IMPORTANT] "${subject}" — ${evaluation.reason}`);
      attemptUnsubscribe_(msg);
      msg.moveToTrash();
    }
  }
}

/**
 * Known two-part ccSLDs (country-code second level domains) to exempt from deep-subdomain penalties.
 */
const KNOWN_CC_SLDS_ = new Set(['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.za', 'com.mx', 'org.uk', 'gov.uk', 'my.id']);

/**
 * Phonotactically rare / impossible Latin digraphs in legitimate brand and domain names.
 */
const RARE_BIGRAMS_ = /(?:jq|qj|qx|xq|qz|zq|jx|xj|jz|zj|vx|xv|wx|xw|zk|kz|bx|cx|dx|fx|gx|hx|kx|lx|mx|nx|px|rx|sx|tx|zx|vq|wq|cg|gk|xx)/;

/**
 * Evaluates all sender transport headers (From, Return-Path, Sender).
 * Returns the highest risk verdict across all available sender identifiers.
 *
 * @param {string} fromHeader
 * @param {string} [returnPathHeader]
 * @param {string} [senderHeader]
 * @param {number} [threshold=70]
 * @return {{isSpam: boolean, score: number, threshold: number, rules: string[], reason: string, sourceHeader: string, rawValue: string}}
 */
function evaluateSenderIdentity_(fromHeader, returnPathHeader, senderHeader, threshold = (typeof CONFIG !== 'undefined' && CONFIG.SPAM_THRESHOLD) || 70) {
  const candidates = [
    { type: 'From', value: fromHeader },
    { type: 'Return-Path', value: returnPathHeader },
    { type: 'Sender', value: senderHeader }
  ].filter(c => !!c.value);

  let worstVerdict = { isSpam: false, score: 0, threshold, rules: [], reason: 'Clean', sourceHeader: 'From', rawValue: fromHeader || '' };

  for (const c of candidates) {
    const verdict = isGibberishSender_(c.value, threshold);
    if (verdict.score > worstVerdict.score) {
      worstVerdict = { ...verdict, sourceHeader: c.type, rawValue: c.value };
    }
    if (verdict.isSpam) {
      return worstVerdict;
    }
  }

  return worstVerdict;
}

/**
 * Score-based evaluation for gibberish / algorithmically generated sender addresses & domains.
 * Accumulates weighted risk points across local-part patterns, domain structure, and phonotactics.
 * No single instant fails; flags as spam when totalScore >= CONFIG.SPAM_THRESHOLD (70).
 *
 * @param {string} fromHeader e.g. 'Name <user@domain.com>'
 * @param {number} [threshold=70] Optional threshold override
 * @return {{isSpam: boolean, score: number, threshold: number, rules: string[], reason: string}}
 */
function isGibberishSender_(fromHeader, threshold = (typeof CONFIG !== 'undefined' && CONFIG.SPAM_THRESHOLD) || 70) {
  const emailMatch = (fromHeader || '').match(/([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (!emailMatch) return { isSpam: false, score: 0, threshold, rules: [], reason: 'Could not parse email' };

  const localPart = emailMatch[1].toLowerCase();
  const domain = emailMatch[2].toLowerCase();
  const domainParts = domain.split('.');

  const rules = [];
  let score = 0;

  function addRule(name, weight, detail) {
    rules.push({ name, weight, detail });
    score += weight;
  }

  // --- 1. Local Part Heuristics ---
  const cleanLocal = localPart.replace(/[^a-z0-9]/g, '');
  const alphaLocal = localPart.replace(/[^a-z]/g, '');

  // Structured tracking IDs / multiple dot-separated numeric segments (e.g. .104.767934)
  if (/(?:\.\d+){2,}$|\.\d+\.\d+/.test(localPart)) {
    addRule('LOCAL_CHAINED_NUMERICS', 35, localPart);
  }

  // Interleaved letter-digit churn
  const digitTransitions = (localPart.match(/[a-z][0-9]|[0-9][a-z]/g) || []).length;
  if (cleanLocal.length >= 10 && digitTransitions >= 4) {
    addRule('LOCAL_ALPHANUM_TRANSITIONS', 35, `${digitTransitions} transitions`);
    if (digitTransitions >= 5) {
      addRule('LOCAL_HIGH_CHURN', 35, `${digitTransitions} transitions`);
    }
  }

  // Excessive local-part length
  if (cleanLocal.length > 28) {
    addRule('LOCAL_EXCESSIVE_LENGTH', 35, `${cleanLocal.length} chars`);
  }

  // Consonant clusters and vowel distributions in username
  if (alphaLocal.length >= 5) {
    if (/[^aeiouy]{8,}/.test(alphaLocal)) {
      addRule('LOCAL_EXTREME_CONSONANTS', 40, alphaLocal);
      addRule('LOCAL_CONSONANT_CLUSTER', 35, alphaLocal);
    } else if (/[^aeiouy]{5,}/.test(alphaLocal)) {
      addRule('LOCAL_CONSONANT_CLUSTER', 35, alphaLocal);
    }

    const localVowels = (alphaLocal.match(/[aeiouy]/g) || []).length;
    const localVowelRatio = localVowels / alphaLocal.length;
    if (alphaLocal.length >= 7 && (localVowelRatio < 0.15 || localVowelRatio > 0.85)) {
      addRule('LOCAL_VOWEL_EXTREME', 35, `${(localVowelRatio * 100).toFixed(0)}%`);
    }
  }

  // Rare bigrams in username (minor hint)
  if (RARE_BIGRAMS_.test(alphaLocal)) {
    addRule('LOCAL_SUSPICIOUS_BIGRAM', 15, alphaLocal);
  }

  // Phonotactic q without u in username
  if (/q(?!u)/.test(alphaLocal)) {
    addRule('LOCAL_Q_WITHOUT_U', 25, alphaLocal);
  }

  // --- 2. Domain Structure Heuristics ---
  if (domain.length > 35) {
    addRule('DOMAIN_EXCESSIVE_LENGTH', 35, `${domain.length} chars`);
  }

  if (domainParts.length >= 5) {
    addRule('DOMAIN_DEEP_SUBDOMAINS_5', 40, `${domainParts.length} levels`);
  } else if (domainParts.length === 4) {
    const lastTwo = domainParts.slice(-2).join('.');
    if (!KNOWN_CC_SLDS_.has(lastTwo)) {
      addRule('DOMAIN_DEEP_SUBDOMAINS_4', 35, domain);
    } else {
      const nonTldParts = domainParts.slice(0, -2);
      if (nonTldParts.every(p => p.length >= 6)) {
        addRule('DOMAIN_BLOATED_SUBDOMAINS', 35, domain);
      }
    }
  }

  for (const part of domainParts) {
    if (part.length > 22) {
      addRule('DOMAIN_LABEL_TOO_LONG', 35, part);
    }
  }

  // --- 3. Domain Linguistics & Entropy Heuristics ---
  const coreDomainLabels = domainParts.slice(0, -1).filter(p => p.length >= 3);

  for (const label of coreDomainLabels) {
    const clean = label.replace(/[^a-z]/g, '');
    if (clean.length < 3) continue;

    // Consonant clusters
    const fourConsonantClusters = (clean.match(/[^aeiouy]{4}/g) || []).length;
    if (/[^aeiouy]{5,}/.test(clean)) {
      addRule('DOMAIN_CONSONANT_CLUSTER', 40, clean);
    } else if (fourConsonantClusters >= 2) {
      addRule('DOMAIN_CONSONANT_CLUSTER', 35, clean);
    } else if (fourConsonantClusters === 1) {
      addRule('DOMAIN_MILD_CONSONANTS', 20, clean);
    }

    // Consecutive vowel cluster
    if (/[aeiouy]{4,}/.test(clean)) {
      addRule('DOMAIN_VOWEL_CLUSTER', 35, clean);
    }

    // Rare bigrams (minor hint)
    if (RARE_BIGRAMS_.test(clean)) {
      addRule('DOMAIN_SUSPICIOUS_BIGRAM', 15, clean);
    }

    // Phonotactic q without u
    if (/q(?!u)/.test(clean)) {
      addRule('DOMAIN_Q_WITHOUT_U', 25, clean);
    }

    if (clean.length >= 6) {
      const vowels = (clean.match(/[aeiouy]/g) || []).length;
      const vowelRatio = vowels / clean.length;
      if (vowelRatio < 0.18 || vowelRatio > 0.78) {
        addRule('DOMAIN_VOWEL_EXTREME', 35, `${(vowelRatio * 100).toFixed(0)}%`);
      }

      const rareCount = (clean.match(/[jqxzvkw]/g) || []).length;
      if (rareCount / clean.length >= 0.35) {
        addRule('DOMAIN_RARE_CONSONANTS', 35, `${(rareCount / clean.length * 100).toFixed(0)}%`);
      }
    }

    if (clean.length >= 10) {
      const entropy = shannonEntropy_(clean);
      if (entropy > 3.35) {
        addRule('DOMAIN_EXTREME_ENTROPY', 40, `${entropy.toFixed(2)} bits`);
        addRule('DOMAIN_HIGH_ENTROPY', 30, `${entropy.toFixed(2)} bits`);
      } else if (entropy > 3.0) {
        addRule('DOMAIN_HIGH_ENTROPY', 25, `${entropy.toFixed(2)} bits`);
      }
    }
  }

  return {
    isSpam: score >= threshold,
    score,
    threshold,
    rules: rules.map(r => r.name),
    reason: rules.map(r => `${r.name}(+${r.weight})`).join(', ') || 'Clean'
  };
}

/**
 * Computes Shannon entropy (bits per character) of a string.
 */
function shannonEntropy_(str) {
  const len = str.length;
  if (!len) return 0;
  const freq = {};
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  let entropy = 0;
  for (const ch in freq) {
    const p = freq[ch] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Calls Gemini API with structured JSON output to classify an Inbox email.
 */
function evaluateEmailWithGemini_(msg, apiKey) {
  const from = msg.getFrom();
  const subject = msg.getSubject();
  const listUnsub = msg.getHeader('List-Unsubscribe') || 'None';
  const bodySnippet = (msg.getPlainBody() || '').slice(0, 2000);

  const prompt = `Evaluate this email and classify it strictly into one of three categories:
- "IMPORTANT": Personal emails, work, receipts, security codes, bills, account alerts, or anything requiring attention.
- "UNDECIDED": Ambiguous emails where you are not 100% sure it is useless.
- "NOT_IMPORTANT": 100% certain it is unimportant (marketing promotions, cold outreach, surveys, newsletters you didn't ask for). Only choose NOT_IMPORTANT if you are 100% certain.

From: ${from}
Subject: ${subject}
List-Unsubscribe Header: ${listUnsub}
Body:
${bodySnippet}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: 'LOW' },
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          verdict: { type: 'STRING', enum: ['IMPORTANT', 'UNDECIDED', 'NOT_IMPORTANT'] },
          reason: { type: 'STRING' }
        },
        required: ['verdict', 'reason']
      }
    }
  };

  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const status = res.getResponseCode();
    const raw = res.getContentText();
    if (status !== 200) {
      console.error(`Gemini HTTP ${status}: ${raw}`);
      return { verdict: 'UNDECIDED', reason: `HTTP ${status}` };
    }
    const data = JSON.parse(raw);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? JSON.parse(text) : { verdict: 'UNDECIDED', reason: 'Empty API response' };
  } catch (e) {
    console.error(`Gemini error: ${e.message}`);
    return { verdict: 'UNDECIDED', reason: 'API error fallback' };
  }
}

/**
 * Attempts RFC 8058 One-Click HTTP Unsubscribe, HTTP GET fallback, or mailto: unsubscribe.
 */
function attemptUnsubscribe_(msg) {
  const unsubHeader = msg.getHeader('List-Unsubscribe');
  const unsubPostHeader = msg.getHeader('List-Unsubscribe-Post');

  if (unsubHeader) {
    const httpMatch = unsubHeader.match(/<(https?:\/\/[^>]+)>/i);
    const mailtoMatch = unsubHeader.match(/<mailto:([^>?]+)(?:\?subject=([^>]+))?>/i);

    if (httpMatch) {
      const url = httpMatch[1];
      try {
        if (unsubPostHeader && unsubPostHeader.includes('List-Unsubscribe=One-Click')) {
          UrlFetchApp.fetch(url, {
            method: 'post',
            payload: 'List-Unsubscribe=One-Click',
            muteHttpExceptions: true,
            followRedirects: true
          });
          return;
        } else {
          UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, followRedirects: true });
          return;
        }
      } catch (e) {
        console.warn(`HTTP unsubscribe failed: ${e.message}`);
      }
    }

    if (mailtoMatch) {
      const to = mailtoMatch[1];
      const subject = decodeURIComponent(mailtoMatch[2] || 'unsubscribe');
      try {
        GmailApp.sendEmail(to, subject, 'Unsubscribe');
        return;
      } catch (e) {
        console.warn(`Mailto unsubscribe failed: ${e.message}`);
      }
    }
  }
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

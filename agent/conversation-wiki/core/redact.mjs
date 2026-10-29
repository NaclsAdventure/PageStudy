/** 在会话进入本地 Wiki 或飞书之前做一次保守脱敏。 */

const RULES = [
  [
    /((?:api[_-]?key|app[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization)\s*[:=]\s*)(["']?)([^\s"',;]{6,})\2/gi,
    '$1$2[已脱敏]$2',
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [已脱敏]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '[已脱敏 API Key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[已脱敏 GitHub Token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[已脱敏 Slack Token]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已脱敏私钥]'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, (match) => (match.length >= 64 ? '[已脱敏长密钥]' : match)],
];

export function redactText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of RULES) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function redactMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    ...message,
    text: redactText(message.text),
  }));
}

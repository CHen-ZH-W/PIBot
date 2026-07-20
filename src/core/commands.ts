const trailingCommandPunctuationPattern = /[\s"'`。！？!?.，,；;：:]+$/gu;
const leadingCommandWrapperPattern = /^[\s"'`]+/gu;

const stopCommandPattern =
  /^(?:(?:please\s+)?(?:stop|cancel|abort|halt|quit)(?:\s+(?:please|now))?|(?:请|麻烦)?(?:先)?(?:停止|取消|中止|终止|暂停|停下|停一下|别做了|先别做了|别继续了|不要继续了|不用了|不用继续了)(?:一下|吧|了)?|停)$/iu;

export function isStopCommandText(text: string): boolean {
  return stopCommandPattern.test(normalizeCommandText(text));
}

function normalizeCommandText(text: string): string {
  return text
    .trim()
    .replace(leadingCommandWrapperPattern, "")
    .replace(trailingCommandPunctuationPattern, "")
    .trim();
}

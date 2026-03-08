export type TurnAutoContinueContext = {
  userText: string;
  assistantText: string;
  hadToolOutput: boolean;
  awaitingInteraction: boolean;
  continuationCount: number;
};

const PLACEHOLDER_REPLY_PATTERN = /^(?:好的[，, ]*)?(?:我去查|我查下|我来查|我先查|我看看|我去看|让我查|稍等(?:一下)?|正在查询|我先确认|我去搜索|我来看看)(?:一下|下)?(?:[，, ]*(?:稍等(?:一下)?|等我确认|我马上回来|我马上给你结果))?[。！？!?… ]*$/;
const REALTIME_QUERY_PATTERN = /(天气|温度|汇率|股价|价格|航班|比分|最新|今天|现在|实时)/;
const TERMINAL_REPLY_PATTERN = /[。！？!?」』”"']$/;
const INCOMPLETE_REPLY_PATTERN = /(?:[:：,，、；;(\[（-]|\b(?:比如|例如|包括|如下|总结|结论|下一步|继续|首先|其次|最后))$/;

export function shouldAutoContinueTurn(
  turnContext: TurnAutoContinueContext,
  maxAutoContinuations: number,
): boolean {
  if (turnContext.awaitingInteraction) {
    return false;
  }

  if (turnContext.continuationCount >= maxAutoContinuations) {
    return false;
  }

  const assistantText = normalizeTurnText(turnContext.assistantText);
  const userText = normalizeTurnText(turnContext.userText);

  if (isPlaceholderAssistantReply(assistantText)) {
    return true;
  }

  if (!assistantText && REALTIME_QUERY_PATTERN.test(userText) && !turnContext.hadToolOutput) {
    return true;
  }

  if (looksTruncatedAssistantReply(assistantText) && turnContext.hadToolOutput) {
    return true;
  }

  return false;
}

export function normalizeTurnText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isPlaceholderAssistantReply(assistantText: string): boolean {
  if (!assistantText) {
    return false;
  }

  if (assistantText.length > 48) {
    return false;
  }

  return PLACEHOLDER_REPLY_PATTERN.test(assistantText);
}

function looksTruncatedAssistantReply(assistantText: string): boolean {
  if (!assistantText || assistantText.length < 220) {
    return false;
  }

  if (hasUnclosedCodeFence(assistantText)) {
    return true;
  }

  if (TERMINAL_REPLY_PATTERN.test(assistantText)) {
    return false;
  }

  const lastLine = assistantText.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? assistantText;
  if (/^\d+\.$/.test(lastLine) || /^[-*]\s*$/.test(lastLine)) {
    return true;
  }

  return INCOMPLETE_REPLY_PATTERN.test(lastLine);
}

function hasUnclosedCodeFence(text: string): boolean {
  return (text.match(/```/g) ?? []).length % 2 === 1;
}

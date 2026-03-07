export type TurnAutoContinueContext = {
  userText: string;
  assistantText: string;
  hadToolOutput: boolean;
  awaitingInteraction: boolean;
  continuationCount: number;
};

const PLACEHOLDER_REPLY_PATTERN = /^(?:好的[，, ]*)?(?:我去查|我查下|我来查|我先查|我看看|我去看|让我查|稍等(?:一下)?|正在查询|我先确认|我去搜索|我来看看)(?:一下|下)?(?:[，, ]*(?:稍等(?:一下)?|等我确认|我马上回来|我马上给你结果))?[。！？!?… ]*$/;
const REALTIME_QUERY_PATTERN = /(天气|温度|汇率|股价|价格|航班|比分|最新|今天|现在|实时)/;

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

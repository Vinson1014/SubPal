import { StorageAdapter } from '../system/config/storage-adapter.js';

export class SubmissionQueueManager {
  constructor(options = {}) {
    this.storage = options.storage || new StorageAdapter(options);
    this.isInitialized = false;
  }

  async initialize() {
    if (this.isInitialized) return;
    await this.storage.initialize();
    this.isInitialized = true;
  }

  async getVoteHistory(limit = 100) {
    return await this.storage.getHistory('vote', limit);
  }

  async getVoteStatus(itemId) {
    if (!itemId) throw new Error('itemId is required');
    const queue = await this.storage.getQueue('vote');
    const queued = queue.find((item) => item.id === itemId);
    if (queued) return { status: queued.status, error: queued.error };
    const history = await this.storage.getHistory('vote', 100);
    const completed = history.find((item) => item.id === itemId);
    if (completed) return { status: completed.status, error: null };
    throw new Error(`Vote item not found: ${itemId}`);
  }

  async getVoteAuthority(translationID) {
    const [voteStateData, voteQueue] = await Promise.all([
      this.storage.get('voteStateByTranslation'),
      this.storage.getQueue('vote')
    ]);
    const permanentFailure = voteQueue.find((item) => (
      item.translationID === translationID && item.status === 'failed' &&
      item.errorMetadata?.isPermanent && item.previousVoteState !== undefined &&
      item.previousCounts !== undefined
    ));
    return {
      authority: voteStateData.voteStateByTranslation?.[translationID] ?? null,
      hasPendingVote: voteQueue.some((item) => item.translationID === translationID &&
        (item.status === 'pending' || item.status === 'syncing')),
      permanentFailure: permanentFailure ? {
        previousVoteState: permanentFailure.previousVoteState,
        previousCounts: permanentFailure.previousCounts
      } : null
    };
  }

  async getTranslationHistory(limit = 100) {
    return await this.storage.getHistory('translation', limit);
  }

  async getTranslationReconciliation(itemIds) {
    const ids = new Set(itemIds);
    const [translationQueue, translationHistory] = await Promise.all([
      this.storage.getQueue('translation'),
      this.storage.getHistory('translation', Number.MAX_SAFE_INTEGER)
    ]);
    return {
      translationQueue: translationQueue.filter((item) => ids.has(item.id)),
      translationHistory: translationHistory.filter((item) => ids.has(item.id))
    };
  }

  async getReplacementEventHistory(limit = 100) {
    return await this.storage.getHistory('replacementEvent', limit);
  }

  async getAllPending() {
    const [votes, translations, replacementEvents] = await Promise.all([
      this.storage.getQueue('vote'),
      this.storage.getQueue('translation'),
      this.storage.getQueue('replacementEvent')
    ]);
    return {
      votes: votes.filter((item) => item.status === 'pending'),
      translations: translations.filter((item) => item.status === 'pending'),
      replacementEvents: replacementEvents.filter((item) => item.status === 'pending')
    };
  }

  async getStats() {
    const [votes, translations, replacementEvents] = await Promise.all([
      this.storage.getQueue('vote'),
      this.storage.getQueue('translation'),
      this.storage.getQueue('replacementEvent')
    ]);
    return {
      votes: this.calculateStats(votes),
      translations: this.calculateStats(translations),
      replacementEvents: this.calculateStats(replacementEvents)
    };
  }

  calculateStats(queue) {
    return queue.reduce((stats, item) => {
      stats.total += 1;
      if (Object.hasOwn(stats, item.status)) stats[item.status] += 1;
      return stats;
    }, { total: 0, pending: 0, syncing: 0, completed: 0, failed: 0 });
  }
}

export function handleQueueMessage(request, sendResponse) {
  const { type, payload } = request;
  const readOperations = {
    VOTE_GET_HISTORY: async () => ({ history: await submissionQueueManager.getVoteHistory(payload?.limit) }),
    VOTE_GET_STATUS: async () => await submissionQueueManager.getVoteStatus(payload?.itemId),
    VOTE_GET_AUTHORITY: async () => await submissionQueueManager.getVoteAuthority(payload?.translationID),
    TRANSLATION_GET_HISTORY: async () => ({ history: await submissionQueueManager.getTranslationHistory(payload?.limit) }),
    TRANSLATION_GET_RECONCILIATION: async () => await submissionQueueManager.getTranslationReconciliation(payload?.itemIds),
    REPLACEMENT_EVENT_GET_HISTORY: async () => ({ history: await submissionQueueManager.getReplacementEventHistory(payload?.limit) }),
    GET_ALL_PENDING: async () => await submissionQueueManager.getAllPending(),
    GET_QUEUE_STATS: async () => await submissionQueueManager.getStats()
  };
  if (!submissionQueueManager.isInitialized) {
    sendResponse({ error: 'SubmissionQueueManager not initialized' });
    return true;
  }
  const operation = readOperations[type];
  if (!operation) {
    sendResponse({ error: `Unsupported queue message type: ${type}` });
    return true;
  }
  operation().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
  return true;
}

export const submissionQueueManager = new SubmissionQueueManager({ debug: false });

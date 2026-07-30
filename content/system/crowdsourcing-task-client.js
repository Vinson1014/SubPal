import { createEnvelope, createRuntimeTransport } from './capabilities/private-transports.js';

function requestCrowdsourcingTasks(message) {
  const transport = createRuntimeTransport({ runtime: chrome.runtime });
  return transport.request(createEnvelope({
    requestId: `crowdsourcing_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    kind: 'crowdsourcing-task-query',
    payload: message
  })).then((result) => {
    if (result.ok) return result.value;
    return Promise.reject(new Error('Crowdsourcing task request failed'));
  });
}

export { requestCrowdsourcingTasks };

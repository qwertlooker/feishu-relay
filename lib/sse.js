'use strict';

function createSseHub() {
  const clients = new Map();

  return {
    add(response) {
      const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      clients.set(clientId, response);
      return clientId;
    },

    remove(clientId) {
      clients.delete(clientId);
    },

    broadcast(event, data) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      clients.forEach((response, clientId) => {
        try {
          response.write(payload);
        } catch {
          clients.delete(clientId);
        }
      });
    },

    get size() {
      return clients.size;
    },
  };
}

module.exports = { createSseHub };

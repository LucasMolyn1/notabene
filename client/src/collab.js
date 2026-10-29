// Co-édition temps réel : document Yjs synchronisé avec le serveur (protocole y-websocket).
// Le serveur persiste l'état et resynchronise le contenu JSON de la page ; ici on ne gère que la connexion.
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { WebsocketProvider } from 'y-websocket';

const MSG_EPOCH = 100;

// callbacks : onSynced(), onStatus('connected'|'disconnected'), onReload() (contenu modifié ailleurs), onGone()
export function connectCollab(pageId, callbacks) {
  const ydoc = new Y.Doc();
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const provider = new WebsocketProvider(`${scheme}://${location.host}/collab`, pageId, ydoc, { disableBc: true });
  let epoch = null;
  let stopped = false;

  // « Époque » de l'état serveur : si elle change (page réamorcée), notre copie locale est obsolète
  // et la fusionner dupliquerait le contenu : on repart de zéro.
  provider.messageHandlers[MSG_EPOCH] = (_encoder, decoder) => {
    const value = decoding.readVarString(decoder);
    if (epoch !== null && epoch !== value && !stopped) { stopped = true; provider.destroy(); callbacks.onReload?.(); return; }
    epoch = value;
  };

  provider.on('sync', (synced) => { if (synced && !stopped) callbacks.onSynced?.(); });
  provider.on('status', ({ status }) => { if (!stopped) callbacks.onStatus?.(status); });
  provider.on('closed', ({ code }) => {
    if (stopped) return;
    stopped = true;
    provider.destroy();
    if (code === 4409) callbacks.onReload?.();
    else callbacks.onGone?.(code);
  });

  return {
    ydoc,
    provider,
    destroy() {
      stopped = true;
      provider.destroy();
      ydoc.destroy();
    },
  };
}

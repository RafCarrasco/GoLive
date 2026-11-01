// Somente para o emulador local: aprova todas as solicitações pendentes.
// A conta owner@nimbo.test vira proprietária; as demais, membros.
// Uso: entre no app com ?devUser=owner (e outros nomes) e depois rode `npm run emulator:approve`.
const base = 'http://127.0.0.1:9000';
const ns = '?ns=demo-nimbo-default-rtdb';
const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

const res = await fetch(`${base}/community/requests.json${ns}`, { headers });
const requests = (await res.json()) || {};
const patch = {};
for (const [uid, request] of Object.entries(requests)) {
  patch[`community/approved/${uid}`] = true;
  patch[`community/roles/${uid}`] = request.email.startsWith('owner@') ? 'owner' : 'member';
  patch[`community/requests/${uid}`] = null;
}
if (!Object.keys(patch).length) {
  console.log('Nenhuma solicitação pendente no emulador.');
} else {
  await fetch(`${base}/.json${ns}`, { method: 'PATCH', headers, body: JSON.stringify(patch) });
  console.log(
    'Aprovados:',
    Object.values(requests)
      .map((r) => r.email)
      .join(', '),
  );
}

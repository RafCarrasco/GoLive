// Testes das regras do Realtime Database. Rode com `npm run test:rules` (usa o emulador local,
// projeto demo-nimbo, sem tocar no Firebase de produção).
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { get, ref, remove, set, update } from 'firebase/database';

const rules = readFileSync(
  process.env.RULES_FILE || new URL('../database.rules.json', import.meta.url),
  'utf8',
);
let env;

const as = (uid, provider = 'google.com') =>
  env
    .authenticatedContext(uid, {
      email: uid + '@example.com',
      firebase: { sign_in_provider: provider, identities: {} },
    })
    .database();
const owner = () => as('owner');
const admin = () => as('admin');
const member = () => as('member');
const pending = () => as('pending');

before(async () => {
  const [host, port] = (process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9000').split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-nimbo',
    database: { rules, host, port: Number(port) },
  });
});
after(() => env?.cleanup());

beforeEach(async () => {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await set(ref(ctx.database(), '/'), {
      community: {
        approved: { owner: true, admin: true, member: true, anon: true },
        roles: { owner: 'owner', admin: 'admin', member: 'member' },
        profiles: { member: { displayName: 'Membro', createdAt: 1, updatedAt: 1 } },
        requests: { pending: { email: 'pending@example.com', createdAt: 1 } },
        categories: {
          vipcat: { name: 'VIP', createdAt: 1, createdBy: 'owner', order: 1 },
          grupoA: { name: 'Faculdade', createdAt: 1, createdBy: 'owner', order: 2 },
          grupoB: { name: 'Trampo', createdAt: 1, createdBy: 'owner', order: 3 },
        },
        categoryIds: { vipcat: 1, grupoA: 2, grupoB: 3 },
        channelIds: { staff: true, vip: true, off: true, canalA: true, canalB: true },
        roleDefs: {
          faculdade: { name: 'Faculdade', color: '#7c6cff', createdAt: 1 },
          trampo: { name: 'Trampo', color: '#3ecf8e', createdAt: 1 },
        },
        memberRoles: { member: { faculdade: true } },
        categoryRoles: { grupoA: ['faculdade'], grupoB: ['trampo'] },
        channels: {
          staff: {
            name: 'Staff',
            description: '',
            createdBy: 'owner',
            createdAt: 1,
            visibility: 'public',
            enabled: true,
          },
          vip: {
            name: 'VIP',
            description: '',
            categoryId: 'vipcat',
            createdBy: 'owner',
            createdAt: 1,
            visibility: 'public',
            enabled: true,
          },
          canalA: {
            name: 'A',
            description: '',
            categoryId: 'grupoA',
            createdBy: 'owner',
            createdAt: 1,
            visibility: 'public',
            enabled: true,
          },
          canalB: {
            name: 'B',
            description: '',
            categoryId: 'grupoB',
            createdBy: 'owner',
            createdAt: 1,
            visibility: 'public',
            enabled: true,
          },
          off: {
            name: 'Off',
            description: '',
            createdBy: 'owner',
            createdAt: 1,
            visibility: 'public',
            enabled: false,
          },
        },
        channelAccess: { staff: 'admin' },
        categoryAccess: { vipcat: 'owner' },
      },
      rooms: {
        geral: {
          members: { owner: { joinedAt: 1 }, member: { joinedAt: 1 } },
          streams: { owner: { screen: { startedAt: 1, streamId: 's1' } } },
          signals: { owner: { member: { m1: { type: 'ice', candidate: { candidate: 'x' } } } } },
        },
        vip: { members: { owner: { joinedAt: 1 } } },
      },
    });
  });
});

describe('autenticação e aprovação', () => {
  test('visitante sem login não lê nada', async () => {
    const db = env.unauthenticatedContext().database();
    await assertFails(get(ref(db, 'rooms/geral/members')));
    await assertFails(get(ref(db, 'community/channels')));
  });
  test('conta pendente não lê canais nem salas', async () => {
    await assertFails(get(ref(pending(), 'community/channels')));
    await assertFails(get(ref(pending(), 'rooms/geral/members')));
  });
  test('login anônimo é bloqueado mesmo com aprovação', async () => {
    const db = as('anon', 'anonymous');
    await assertFails(get(ref(db, 'community/channels')));
    await assertFails(get(ref(db, 'rooms/geral/members')));
  });
  test('usuário lê apenas a própria aprovação', async () => {
    await assertSucceeds(get(ref(pending(), 'community/approved/pending')));
    await assertFails(get(ref(pending(), 'community/approved/member')));
    await assertFails(get(ref(member(), 'community/approved')));
    await assertSucceeds(get(ref(owner(), 'community/approved')));
  });
  test('ninguém além do proprietário aprova', async () => {
    await assertFails(set(ref(pending(), 'community/approved/pending'), true));
    await assertFails(set(ref(admin(), 'community/approved/pending'), true));
    await assertSucceeds(set(ref(owner(), 'community/approved/pending'), true));
  });
  test('proprietário não revoga a própria aprovação', async () => {
    await assertFails(set(ref(owner(), 'community/approved/owner'), false));
    await assertFails(remove(ref(owner(), 'community/approved/owner')));
    await assertSucceeds(remove(ref(owner(), 'community/approved/member')));
  });
});

describe('solicitações', () => {
  test('usuário cria a própria solicitação com o próprio e-mail', async () => {
    await assertSucceeds(
      set(ref(pending(), 'community/requests/pending'), { email: 'pending@example.com', createdAt: 2 }),
    );
    await assertFails(
      set(ref(pending(), 'community/requests/pending'), { email: 'outro@example.com', createdAt: 2 }),
    );
    await assertFails(
      set(ref(pending(), 'community/requests/member'), { email: 'pending@example.com', createdAt: 2 }),
    );
    await assertFails(
      set(ref(pending(), 'community/requests/pending'), {
        email: 'pending@example.com',
        createdAt: 2,
        role: 'owner',
      }),
    );
  });
  test('somente o proprietário lê e remove solicitações', async () => {
    await assertFails(get(ref(admin(), 'community/requests')));
    await assertSucceeds(get(ref(owner(), 'community/requests')));
    await assertFails(remove(ref(admin(), 'community/requests/pending')));
    await assertSucceeds(remove(ref(owner(), 'community/requests/pending')));
  });
});

describe('cargos', () => {
  test('membro não se promove', async () => {
    await assertFails(set(ref(member(), 'community/roles/member'), 'admin'));
  });
  test('administrador não altera cargos', async () => {
    await assertFails(set(ref(admin(), 'community/roles/member'), 'admin'));
    await assertFails(set(ref(admin(), 'community/roles/admin'), 'owner'));
  });
  test('proprietário altera cargos mas não se rebaixa', async () => {
    await assertSucceeds(set(ref(owner(), 'community/roles/member'), 'admin'));
    await assertFails(set(ref(owner(), 'community/roles/owner'), 'member'));
    await assertFails(remove(ref(owner(), 'community/roles/owner')));
    await assertFails(set(ref(owner(), 'community/roles/member'), 'superuser'));
  });
});

describe('perfis', () => {
  test('nickname de 3 a 24 caracteres, sem campos extras', async () => {
    const p = (displayName, extra = {}) => ({ displayName, createdAt: 1, updatedAt: 2, ...extra });
    await assertSucceeds(set(ref(member(), 'community/profiles/member'), p('Rafa')));
    await assertFails(set(ref(member(), 'community/profiles/member'), p('ab')));
    await assertFails(set(ref(member(), 'community/profiles/member'), p('x'.repeat(25))));
    await assertFails(set(ref(member(), 'community/profiles/member'), p('Rafa', { role: 'owner' })));
    await assertFails(set(ref(member(), 'community/profiles/admin'), p('Rafa')));
    await assertFails(set(ref(pending(), 'community/profiles/pending'), p('Rafa')));
  });
});

describe('servidor de retransmissão', () => {
  const turn = { urls: 'turn:relay.example.com:3478', username: 'u', credential: 'p', updatedAt: 1 };
  test('só o proprietário grava; aprovados leem; pendentes não', async () => {
    await assertSucceeds(set(ref(owner(), 'community/turn'), turn));
    await assertFails(set(ref(admin(), 'community/turn'), turn));
    await assertFails(set(ref(member(), 'community/turn'), turn));
    await assertSucceeds(get(ref(member(), 'community/turn')));
    await assertFails(get(ref(pending(), 'community/turn')));
  });
  test('formato validado', async () => {
    await assertFails(set(ref(owner(), 'community/turn'), { ...turn, urls: 'https://evil.example' }));
    await assertFails(set(ref(owner(), 'community/turn'), { ...turn, username: '' }));
    await assertFails(set(ref(owner(), 'community/turn'), { ...turn, extra: 1 }));
    await assertSucceeds(set(ref(owner(), 'community/turn'), { ...turn, urls: 'turns:relay.example.com:5349,turn:relay.example.com:3478?transport=tcp' }));
    await assertSucceeds(remove(ref(owner(), 'community/turn')));
  });
});

describe('fotos de perfil', () => {
  const webp = 'data:image/webp;base64,' + 'A'.repeat(4000);
  test('cada um troca só a própria foto, pequena e de imagem', async () => {
    await assertSucceeds(set(ref(member(), 'community/avatars/member'), webp));
    await assertSucceeds(set(ref(member(), 'community/avatars/member'), 'https://lh3.googleusercontent.com/a/abc=s128-c'));
    await assertFails(set(ref(member(), 'community/avatars/admin'), webp));
    await assertFails(set(ref(member(), 'community/avatars/member'), 'data:image/webp;base64,' + 'A'.repeat(30000)));
    await assertFails(set(ref(member(), 'community/avatars/member'), 'data:text/html;base64,PHNjcmlwdD4='));
    await assertFails(set(ref(member(), 'community/avatars/member'), 'https://evil.example/foto.png'));
    await assertFails(set(ref(member(), 'community/avatars/member'), { url: webp }));
    await assertFails(set(ref(pending(), 'community/avatars/pending'), webp));
    await assertSucceeds(remove(ref(member(), 'community/avatars/member')));
  });
  test('membros aprovados veem as fotos; pendentes não', async () => {
    await assertSucceeds(get(ref(member(), 'community/avatars')));
    await assertFails(get(ref(pending(), 'community/avatars')));
  });
  test('proprietário pode apagar a foto de alguém, mas não trocar', async () => {
    await env.withSecurityRulesDisabled((ctx) => set(ref(ctx.database(), 'community/avatars/member'), webp));
    await assertFails(set(ref(owner(), 'community/avatars/member'), webp));
    await assertFails(remove(ref(admin(), 'community/avatars/member')));
    await assertSucceeds(remove(ref(owner(), 'community/avatars/member')));
  });
});

describe('canais e categorias', () => {
  const channel = {
    name: 'Novo',
    description: '',
    createdBy: 'admin',
    createdAt: 1,
    visibility: 'public',
    enabled: true,
  };
  test('membro não cria canal; administrador cria', async () => {
    await assertFails(set(ref(member(), 'community/channels/novo'), channel));
    await assertSucceeds(set(ref(admin(), 'community/channels/novo'), channel));
  });
  test('canais padrão não podem ser alterados', async () => {
    await assertFails(set(ref(owner(), 'community/channels/geral'), channel));
  });
  test('categoria padrão é protegida', async () => {
    await assertFails(
      set(ref(owner(), 'community/categories/lives'), { name: 'X', createdAt: 1, createdBy: 'o', order: 0 }),
    );
  });
});

describe('permissões de acesso', () => {
  test('administrador restringe canal a admins', async () => {
    await assertSucceeds(set(ref(admin(), 'community/channelAccess/geral'), 'admin'));
    await assertFails(set(ref(member(), 'community/channelAccess/geral'), 'admin'));
  });
  test('administrador não mexe em restrições de proprietário', async () => {
    await assertFails(set(ref(admin(), 'community/channelAccess/geral'), 'owner'));
    await assertFails(set(ref(admin(), 'community/categoryAccess/vipcat'), 'member'));
    await assertFails(remove(ref(admin(), 'community/categoryAccess/vipcat')));
    await assertSucceeds(set(ref(owner(), 'community/categoryAccess/vipcat'), 'member'));
  });
  test('valor de acesso inválido é rejeitado', async () => {
    await assertFails(set(ref(owner(), 'community/channelAccess/geral'), 'everyone'));
  });
});

describe('salas', () => {
  test('membro aprovado lê presença e lives de canal liberado', async () => {
    await assertSucceeds(get(ref(member(), 'rooms/geral/members')));
    await assertSucceeds(get(ref(member(), 'rooms/geral/streams')));
  });
  test('ninguém lê a sala inteira (inclui sinalização alheia)', async () => {
    await assertFails(get(ref(member(), 'rooms/geral')));
    await assertFails(get(ref(owner(), 'rooms')));
  });
  test('canal restrito a admins', async () => {
    await assertFails(get(ref(member(), 'rooms/staff/members')));
    await assertSucceeds(get(ref(admin(), 'rooms/staff/members')));
    await assertSucceeds(get(ref(owner(), 'rooms/staff/members')));
    await assertFails(set(ref(member(), 'rooms/staff/members/member'), { joinedAt: 1 }));
  });
  test('herança: categoria somente do proprietário bloqueia o canal', async () => {
    await assertFails(get(ref(member(), 'rooms/vip/members')));
    await assertFails(get(ref(admin(), 'rooms/vip/members')));
    await assertSucceeds(get(ref(owner(), 'rooms/vip/members')));
  });
  test('categoria padrão restrita bloqueia canais sem categoria', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      set(ref(ctx.database(), 'community/categoryAccess/lives'), 'admin'),
    );
    await assertFails(get(ref(member(), 'rooms/geral/members')));
    await assertSucceeds(get(ref(admin(), 'rooms/geral/members')));
  });
  test('canal desativado ou inexistente não abre', async () => {
    await assertFails(get(ref(owner(), 'rooms/off/members')));
    await assertFails(get(ref(owner(), 'rooms/fantasma/members')));
    await assertFails(set(ref(owner(), 'rooms/fantasma/members/owner'), { joinedAt: 1 }));
  });
  test('entrar no canal: somente o próprio registro e com formato válido', async () => {
    await assertSucceeds(set(ref(admin(), 'rooms/geral/members/admin'), { joinedAt: 5 }));
    await assertFails(set(ref(member(), 'rooms/geral/members/admin'), { joinedAt: 5 }));
    await assertFails(set(ref(member(), 'rooms/geral/members/member'), { joinedAt: 'agora' }));
    await assertFails(set(ref(member(), 'rooms/geral/members/member'), { joinedAt: 1, host: true }));
  });
  test('sair é sempre permitido, mesmo após perder o acesso', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      set(ref(ctx.database(), 'community/channelAccess/geral'), 'owner'),
    );
    await assertSucceeds(remove(ref(member(), 'rooms/geral/members/member')));
  });
  test('administrador remove sessão abandonada; membro não remove outros', async () => {
    await assertFails(remove(ref(member(), 'rooms/geral/members/owner')));
    await assertSucceeds(remove(ref(admin(), 'rooms/geral/members/member')));
  });
  test('transmissão exige estar no canal', async () => {
    const live = { startedAt: 1, streamId: 'abc' };
    await assertSucceeds(set(ref(member(), 'rooms/geral/streams/member/screen'), live));
    await assertSucceeds(set(ref(member(), 'rooms/geral/streams/member/camera'), live));
    await assertFails(set(ref(admin(), 'rooms/geral/streams/admin/screen'), live));
    await assertFails(set(ref(member(), 'rooms/geral/streams/owner/screen'), live));
    await assertFails(set(ref(member(), 'rooms/geral/streams/member/virus'), live));
    await assertFails(set(ref(member(), 'rooms/geral/streams/member'), true));
    await assertFails(set(ref(member(), 'rooms/geral/streams/member/screen'), { startedAt: 1 }));
  });
  test('encerrar uma live mantém a outra; sair remove todas', async () => {
    const live = { startedAt: 1, streamId: 'abc' };
    await assertSucceeds(set(ref(member(), 'rooms/geral/streams/member'), { screen: live, camera: live }));
    await assertSucceeds(remove(ref(member(), 'rooms/geral/streams/member/screen')));
    await assertSucceeds(remove(ref(member(), 'rooms/geral/streams/member')));
  });
});

describe('sinalização WebRTC', () => {
  const offer = { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } };
  test('cada um lê somente a própria caixa', async () => {
    await assertSucceeds(get(ref(owner(), 'rooms/geral/signals/owner')));
    await assertFails(get(ref(member(), 'rooms/geral/signals/owner')));
    await assertFails(get(ref(member(), 'rooms/geral/signals')));
  });
  test('envio somente entre participantes da sala e sem falsificar remetente', async () => {
    await assertSucceeds(set(ref(member(), 'rooms/geral/signals/owner/member/m2'), offer));
    await assertFails(set(ref(member(), 'rooms/geral/signals/admin/member/m2'), offer));
    await assertFails(set(ref(member(), 'rooms/geral/signals/owner/admin/m2'), offer));
    await assertFails(set(ref(member(), 'rooms/geral/signals/owner/member/m1'), { type: 'bogus' }));
  });
  test('mensagens não podem ser sobrescritas pelo remetente', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      set(ref(ctx.database(), 'rooms/geral/signals/owner/member/m3'), offer),
    );
    await assertFails(set(ref(member(), 'rooms/geral/signals/owner/member/m3'), offer));
  });
  test('destinatário limpa a própria caixa em lote', async () => {
    await assertFails(update(ref(member(), 'rooms/geral'), { 'signals/owner/member/m1': null }));
    await assertSucceeds(update(ref(owner(), 'rooms/geral'), { 'signals/owner/member/m1': null }));
  });
});

describe('cargos personalizados (grupos)', () => {
  test('o índice mostra só ids; nomes de categorias de outro grupo ficam ocultos', async () => {
    await assertSucceeds(get(ref(member(), 'community/categoryIds')));
    await assertSucceeds(get(ref(member(), 'community/categories/grupoA')));
    await assertFails(get(ref(member(), 'community/categories/grupoB')));
    await assertFails(get(ref(member(), 'community/categories')));
  });
  test('canais herdam o cargo da categoria', async () => {
    await assertSucceeds(get(ref(member(), 'community/channels/canalA')));
    await assertFails(get(ref(member(), 'community/channels/canalB')));
    await assertSucceeds(get(ref(member(), 'rooms/canalA/members')));
    await assertFails(get(ref(member(), 'rooms/canalB/members')));
    await assertFails(set(ref(member(), 'rooms/canalB/members/member'), { joinedAt: 1 }));
  });
  test('canais sem cargo continuam visíveis para todos', async () => {
    await assertSucceeds(get(ref(member(), 'rooms/geral/members')));
  });
  test('ganhar o cargo libera a categoria na hora', async () => {
    await assertSucceeds(set(ref(owner(), 'community/memberRoles/member/trampo'), true));
    await assertSucceeds(get(ref(member(), 'community/categories/grupoB')));
    await assertSucceeds(get(ref(member(), 'rooms/canalB/members')));
  });
  test('canal pode exigir um cargo próprio dentro da categoria', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      set(ref(ctx.database(), 'community/channelRoles/canalA'), ['trampo']),
    );
    await assertSucceeds(get(ref(member(), 'community/categories/grupoA')));
    await assertFails(get(ref(member(), 'community/channels/canalA')));
    await assertFails(get(ref(member(), 'rooms/canalA/members')));
  });
  test('qualquer um dos cargos marcados libera', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      set(ref(ctx.database(), 'community/categoryRoles/grupoB'), ['outro', 'faculdade']),
    );
    await assertSucceeds(get(ref(member(), 'community/categories/grupoB')));
  });
  test('administradores e o proprietário veem tudo', async () => {
    await assertSucceeds(get(ref(admin(), 'community/categories/grupoB')));
    await assertSucceeds(get(ref(admin(), 'rooms/canalB/members')));
    await assertSucceeds(get(ref(owner(), 'community/channels/canalA')));
  });
  test('somente o proprietário cria e atribui cargos', async () => {
    const role = { name: 'Novo', color: '#ff0000', createdAt: 1 };
    await assertFails(set(ref(member(), 'community/memberRoles/member/trampo'), true));
    await assertFails(set(ref(admin(), 'community/memberRoles/member/trampo'), true));
    await assertFails(set(ref(admin(), 'community/roleDefs/novo'), role));
    await assertFails(set(ref(admin(), 'community/categoryRoles/grupoA'), ['trampo']));
    await assertSucceeds(set(ref(owner(), 'community/roleDefs/novo'), role));
    await assertSucceeds(set(ref(owner(), 'community/categoryRoles/grupoA'), ['trampo', 'novo']));
  });
  test('validação de cargos', async () => {
    await assertFails(set(ref(owner(), 'community/roleDefs/x'), { name: 'X', color: 'roxo', createdAt: 1 }));
    await assertFails(
      set(ref(owner(), 'community/roleDefs/x'), { name: 'Ok', color: '#123456', createdAt: 1, admin: true }),
    );
    await assertFails(set(ref(owner(), 'community/categoryRoles/grupoA'), { 7: 'trampo' }));
    await assertFails(set(ref(owner(), 'community/memberRoles/member/trampo'), 'sim'));
  });
});

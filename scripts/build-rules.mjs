// Gera database.rules.json a partir de expressões reutilizáveis.
// O RTDB não tem funções nas regras, então montamos as strings aqui para evitar copiar
// a mesma verificação de acesso em cada nó. Rode `npm run rules:build` após editar.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SYSTEM_CHANNELS = ['geral', 'competitivo'];
const DEFAULT_CATEGORY = 'lives';

const or = (...parts) => '(' + parts.join(' || ') + ')';
const and = (...parts) => '(' + parts.join(' && ') + ')';

const google = "auth != null && auth.token.firebase.sign_in_provider === 'google.com'";
const role = "root.child('community/roles').child(auth.uid).val()";
const isOwner = `${role} === 'owner'`;
const isAdmin = or(isOwner, `${role} === 'admin'`);
const approved = and(google, "root.child('community/approved').child(auth.uid).val() === true");
const approvedAdmin = and(approved, isAdmin);
const approvedOwner = and(approved, isOwner);

// Nível mínimo exigido por um nó de acesso (member | admin | owner). O proprietário sempre passa.
const levelOk = (node) =>
  or(`!${node}.exists()`, `${node}.val() === 'member'`, and(`${node}.val() === 'admin'`, isAdmin), isOwner);

// Cargos personalizados (grupos de amigos). Uma categoria ou canal pode exigir até ROLE_SLOTS cargos,
// guardados em posições fixas ("0".."4") porque as regras não conseguem percorrer listas.
// Sem nenhum cargo marcado, vale só o nível (member/admin/owner). Administradores ignoram cargos.
const ROLE_SLOTS = 5;
const slots = Array.from({ length: ROLE_SLOTS }, (_, i) => String(i));
const hasRole = (roleId) => `root.child('community/memberRoles').child(auth.uid).child(${roleId}).exists()`;
const rolesOk = (node) =>
  or(
    `!${node}.exists()`,
    isAdmin,
    ...slots.map((i) => and(`${node}.child('${i}').exists()`, hasRole(`${node}.child('${i}').val()`))),
  );
const categoryVisible = (id) =>
  and(
    levelOk(`root.child('community/categoryAccess').child(${id})`),
    rolesOk(`root.child('community/categoryRoles').child(${id})`),
  );

// Visibilidade de um canal (metadados e sala). O guard em categoryId evita child(null), que invalida
// a regra; canal sem categoria pertence à categoria padrão.
const channelVisible = (idVar) => {
  const node = `root.child('community/channels').child(${idVar})`;
  const categoryId = `${node}.child('categoryId')`;
  return and(
    levelOk(`root.child('community/channelAccess').child(${idVar})`),
    rolesOk(`root.child('community/channelRoles').child(${idVar})`),
    or(
      and(`${categoryId}.exists()`, categoryVisible(`${categoryId}.val()`)),
      and(`!${categoryId}.exists()`, categoryVisible(`'${DEFAULT_CATEGORY}'`)),
    ),
  );
};
const channelExists = or(
  ...SYSTEM_CHANNELS.map((id) => `$room === '${id}'`),
  "root.child('community/channels').child($room).child('enabled').val() === true",
);
const canRoom = and(approved, channelExists, channelVisible('$room'));

const member = (uidExpr) => `root.child('rooms').child($room).child('members').child(${uidExpr}).exists()`;
const accessLevel = "newData.val() === 'member' || newData.val() === 'admin' || newData.val() === 'owner'";
// Somente o proprietário pode criar, remover ou alterar uma restrição "somente proprietário".
const accessWrite = and(
  approvedAdmin,
  or(isOwner, and("data.val() !== 'owner'", "newData.val() !== 'owner'")),
);
const noOtherFields = { $other: { '.validate': false } };
const str = (field, min, max) =>
  and(
    `newData.child('${field}').isString()`,
    `newData.child('${field}').val().length >= ${min}`,
    `newData.child('${field}').val().length <= ${max}`,
  );

const rules = {
  rules: {
    rooms: {
      $room: {
        members: {
          '.read': canRoom,
          $uid: {
            // Entrar exige acesso ao canal; sair (ou o onDisconnect) é sempre permitido ao próprio usuário.
            // Administradores podem remover sessões abandonadas.
            '.write': or(
              and(canRoom, 'auth.uid === $uid'),
              and(google, 'auth.uid === $uid', '!newData.exists()'),
              and(approvedAdmin, '!newData.exists()'),
            ),
            '.validate': "newData.hasChildren(['joinedAt']) && newData.child('joinedAt').isNumber()",
            joinedAt: { '.validate': 'newData.isNumber()' },
            ...noOtherFields,
          },
        },
        streams: {
          '.read': canRoom,
          $uid: {
            '.write': or(
              and(canRoom, 'auth.uid === $uid', member('$uid')),
              and(google, 'auth.uid === $uid', '!newData.exists()'),
              and(approvedAdmin, '!newData.exists()'),
            ),
            // Cada pessoa pode ter uma live de tela e uma de câmera ao mesmo tempo.
            '.validate': 'newData.hasChildren()',
            $kind: {
              '.validate': and(
                "($kind === 'screen' || $kind === 'camera')",
                "newData.hasChildren(['startedAt','streamId'])",
                "newData.child('startedAt').isNumber()",
                "newData.child('streamId').isString()",
                "newData.child('streamId').val().length <= 100",
              ),
            },
          },
        },
        signals: {
          $recipient: {
            // Cada pessoa lê apenas a própria caixa de sinalização WebRTC.
            '.read': and(canRoom, 'auth.uid === $recipient'),
            $sender: {
              $message: {
                '.write': or(
                  and(
                    canRoom,
                    'auth.uid === $sender',
                    member('$sender'),
                    member('$recipient'),
                    '!data.exists()',
                  ),
                  and(google, 'auth.uid === $recipient', '!newData.exists()'),
                ),
                '.validate': or(
                  and(
                    "(newData.child('type').val() === 'offer' || newData.child('type').val() === 'answer')",
                    "newData.child('sdp/type').isString()",
                    "newData.child('sdp/sdp').isString()",
                    "newData.child('sdp/sdp').val().length < 200000",
                  ),
                  and("newData.child('type').val() === 'ice'", "newData.hasChild('candidate')"),
                ),
              },
            },
          },
        },
      },
    },
    community: {
      approved: {
        '.read': and(google, isOwner),
        $uid: {
          '.read': and(google, 'auth.uid === $uid'),
          // O proprietário não pode revogar a própria aprovação por acidente.
          '.write': and(approvedOwner, or('$uid !== auth.uid', 'newData.val() === true')),
          '.validate': 'newData.isBoolean()',
        },
      },
      requests: {
        '.read': and(google, isOwner),
        $uid: {
          '.write': or(
            and(google, 'auth.uid === $uid', "auth.token.email === newData.child('email').val()"),
            and(approvedOwner, '!newData.exists()'),
          ),
          '.validate': and(
            "newData.hasChildren(['email','createdAt'])",
            "newData.child('email').isString()",
            "newData.child('createdAt').isNumber()",
          ),
          email: { '.validate': 'newData.isString()' },
          createdAt: { '.validate': 'newData.isNumber()' },
          ...noOtherFields,
        },
      },
      roles: {
        '.read': approved,
        $uid: {
          // O proprietário não pode rebaixar a si mesmo.
          '.write': and(approvedOwner, or('$uid !== auth.uid', "newData.val() === 'owner'")),
          '.validate': "newData.val() === 'admin' || newData.val() === 'member' || newData.val() === 'owner'",
        },
      },
      profiles: {
        '.read': approved,
        $uid: {
          '.write': and(approved, 'auth.uid === $uid', 'newData.exists()'),
          '.validate': and(
            "newData.hasChildren(['displayName','createdAt','updatedAt'])",
            str('displayName', 3, 24),
            "newData.child('createdAt').isNumber()",
            "newData.child('updatedAt').isNumber()",
          ),
          displayName: { '.validate': 'newData.isString()' },
          createdAt: { '.validate': 'newData.isNumber()' },
          updatedAt: { '.validate': 'newData.isNumber()' },
          ...noOtherFields,
        },
      },
      // Índices só com ids (sem nomes): o app descobre o que existe e lê cada item individualmente.
      // Categorias e canais sem acesso são recusados pelo servidor e nem aparecem.
      categoryIds: {
        '.read': approved,
        $id: { '.write': approvedAdmin, '.validate': 'newData.isNumber()' },
      },
      channelIds: {
        '.read': approved,
        $id: { '.write': approvedAdmin, '.validate': 'newData.val() === true' },
      },
      categories: {
        $id: {
          '.read': and(approved, categoryVisible('$id')),
          '.write': and(approvedAdmin, `$id !== '${DEFAULT_CATEGORY}'`),
          '.validate': and(
            "newData.hasChildren(['name','createdAt','createdBy','order'])",
            str('name', 2, 32),
            "newData.child('createdAt').isNumber()",
            "newData.child('order').isNumber()",
            "newData.child('createdBy').isString()",
          ),
        },
      },
      channels: {
        $channel: {
          '.read': and(approved, channelVisible('$channel')),
          '.write': and(approvedAdmin, ...SYSTEM_CHANNELS.map((id) => `$channel !== '${id}'`)),
          '.validate': and(
            "newData.hasChildren(['name','description','createdBy','createdAt','visibility','enabled'])",
            str('name', 2, 32),
            "newData.child('description').isString()",
            "newData.child('enabled').isBoolean()",
            "newData.child('visibility').val() === 'public'",
            "newData.child('createdAt').isNumber()",
            "(!newData.hasChild('categoryId') || newData.child('categoryId').isString())",
          ),
        },
      },
      categoryAccess: {
        '.read': approved,
        $id: { '.write': accessWrite, '.validate': accessLevel },
      },
      channelAccess: {
        '.read': approved,
        $id: { '.write': accessWrite, '.validate': accessLevel },
      },
      roleDefs: {
        '.read': approved,
        $roleId: {
          '.write': approvedOwner,
          '.validate': and(
            "newData.hasChildren(['name','color','createdAt'])",
            str('name', 2, 24),
            "newData.child('color').isString()",
            "newData.child('color').val().matches(/^#[0-9a-fA-F]{6}$/)",
            "newData.child('createdAt').isNumber()",
          ),
          name: { '.validate': 'newData.isString()' },
          color: { '.validate': 'newData.isString()' },
          createdAt: { '.validate': 'newData.isNumber()' },
          ...noOtherFields,
        },
      },
      memberRoles: {
        '.read': approved,
        $uid: {
          '.write': approvedOwner,
          $roleId: { '.validate': 'newData.val() === true' },
        },
      },
      ...Object.fromEntries(
        ['categoryRoles', 'channelRoles'].map((key) => [
          key,
          {
            '.read': approved,
            $id: {
              '.write': approvedOwner,
              $slot: {
                '.validate': and(or(...slots.map((i) => `$slot === '${i}'`)), 'newData.isString()'),
              },
            },
          },
        ]),
      ),
    },
  },
};

const target = fileURLToPath(new URL('../database.rules.json', import.meta.url));
writeFileSync(target, JSON.stringify(rules, null, 2) + '\n');
console.log('database.rules.json atualizado');

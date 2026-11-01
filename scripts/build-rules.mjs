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

const channelNode = "root.child('community/channels').child($room)";
const categoryId = `${channelNode}.child('categoryId')`;
const channelExists = or(
  ...SYSTEM_CHANNELS.map((id) => `$room === '${id}'`),
  `${channelNode}.child('enabled').val() === true`,
);
const channelLevel = levelOk("root.child('community/channelAccess').child($room)");
// Canal sem categoria pertence à categoria padrão. O guard evita child(null), que invalida a regra.
const categoryLevel = or(
  and(`${categoryId}.exists()`, levelOk(`root.child('community/categoryAccess').child(${categoryId}.val())`)),
  and(
    `!${categoryId}.exists()`,
    levelOk(`root.child('community/categoryAccess').child('${DEFAULT_CATEGORY}')`),
  ),
);
const canRoom = and(approved, channelExists, channelLevel, categoryLevel);

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
            '.validate': or(
              'newData.isBoolean()',
              and(
                "newData.hasChildren(['kind','startedAt'])",
                "(newData.child('kind').val() === 'screen' || newData.child('kind').val() === 'camera')",
                "newData.child('startedAt').isNumber()",
              ),
            ),
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
      categories: {
        '.read': approved,
        $id: {
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
        '.read': approved,
        $channel: {
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
    },
  },
};

const target = fileURLToPath(new URL('../database.rules.json', import.meta.url));
writeFileSync(target, JSON.stringify(rules, null, 2) + '\n');
console.log('database.rules.json atualizado');

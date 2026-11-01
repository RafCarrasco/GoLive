# Provisionamento de administrador — ambiente de testes

Não use permissões públicas nem atribuição automática de `owner` no cliente.

1. Entre no Nimbo com Google e copie seu UID no console do Firebase Authentication.
2. No Firebase Realtime Database, crie `community/approved/<UID> = true` e o nó `community/roles/<UID>` com a string `owner`, utilizando o Console **com conta administrativa do projeto**.
3. Atualize o aplicativo. O painel de administração aparecerá na sidebar.
4. No painel, conceda `admin` aos amigos cadastrados. As regras do banco só permitem que o `owner` altere funções.

## Segurança

- As regras ficam em `scripts/build-rules.mjs` e são cobertas por `npm run test:rules` (emulador).
- O proprietário não pode rebaixar o próprio cargo nem revogar a própria aprovação.
- Administradores não alteram cargos nem restrições "somente proprietário".
- Cada pessoa lê apenas a própria caixa de sinalização WebRTC; presença e lives exigem acesso ao canal.

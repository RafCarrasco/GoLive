# Provisionamento de administrador — ambiente de testes

Não use permissões públicas nem atribuição automática de `owner` no cliente.

1. Entre no GoLive e copie seu UID anônimo pelo console do Firebase Authentication (ou identifique o registro do seu perfil após salvar um apelido).
2. No Firebase Realtime Database, crie o nó `community/roles/<UID>` com a string `owner`, utilizando o Console **com conta administrativa do projeto**.
3. Atualize o aplicativo. O painel de administração aparecerá na sidebar.
4. No painel, conceda `admin` aos amigos cadastrados. As regras do banco só permitem que o `owner` altere funções.

**Limite importante:** UID de Firebase Auth anônimo depende da sessão do navegador. Limpar os dados locais pode fazer a conta perder acesso. Antes de abrir a comunidade a outras pessoas, será necessária uma autenticação durável e revisão das regras, inclusive convite, acesso e exclusão de membros.

## Segurança conhecida
- Perfis são somente nomes de exibição, **não** contas verificadas.
- Não use estas regras como autorização de comunidade privada em produção.
- Canais não têm ACL individual implementada. A propriedade `visibility` ainda só representa metadados.
- Exclusão de canal não elimina automaticamente `rooms/<id>` existentes.
- Ainda há problemas possíveis no WebRTC multiusuário/áudio; validar antes de distribuir.

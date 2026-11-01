# Referência técnica: Reversecord e GoLive

Fonte: https://github.com/enginestein/Reversecord (GPL-3.0, engenharia reversa de módulos do Discord).

## Avaliação
Reversecord é uma coleção de componentes extraídos/obtidos por engenharia reversa, não um SDK oficial nem uma base confiável para incluir diretamente em um aplicativo distribuído. Parte do repositório usa binários nativos não auditados. **Não copiamos arquivos nem dependências do Reversecord.**

Ideias aproveitáveis apenas em nível conceitual:
- Camadas distintas de áudio/voz, vídeo/compartilhamento e presença/canais.
- Interface dedicada de transmissão com seleção explícita de fontes.
- Separação do aplicativo de desktop e do backend de sinalização.

## Etapa implementada nesta branch
- Seletor de fonte visual, dentro do app, com miniaturas e abas de monitor/aplicativos.
- Checkbox de áudio do sistema **desmarcado por padrão** para reduzir risco de eco de loopback.
- Uso de preload restrito, IPC com validação da janela emissora e context isolation.

## Limitações e validação
- A captura por processo de jogo e áudio isolado de CS2 ainda **não estão implementadas**.
- Testar a seleção em máquinas com 1 e 2 monitores.
- Testar áudio do sistema ativado e desativado, sem reproduzir a própria live.
- Testar cancelamento e abrir o diálogo várias vezes.
- Confirmar compatibilidade da API de captura de áudio com a versão instalada do Electron.
- Conferir que encerrar uma live não afeta as outras. Isto ainda requer revisão do gerenciador P2P e não está resolvido por este PR.
- Não distribuir como release estável até validar.

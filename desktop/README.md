# GoLive Desktop (Windows)
Cliente leve em termos de instalação: executável portátil, sem necessidade de instalar extensões. Usa Electron e o site Firebase existente.

## Executável
No GitHub, abra Actions > Windows portable > Run workflow. Após o build, baixe o artifact 'GoLive-Windows-Portable'. O binário não é assinado, então o Windows pode apresentar aviso do SmartScreen.

## Captura e limites
Oferece a seleção de janela ou monitor via Electron. **Ainda não há captura garantida do CS2 em tela cheia exclusiva nem isolamento de áudio por processo**: a API Electron usa áudio loopback do sistema. O usuário deve selecionar modo adequado de captura. O streaming continua utilizando o WebRTC existente no site.

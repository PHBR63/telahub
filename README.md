# TelaHub

TelaHub é um aplicativo web instalável para comunicação em equipes, com autenticação própria, comunidades, canais de texto persistentes, presença em tempo real e salas de compartilhamento de tela usando LiveKit/WebRTC.

## Recursos

A interface possui rolagem independente para canais, mensagens, membros, salas e configurações. Na sala de compartilhamento, o conteúdo rola dentro do painel central enquanto o cabeçalho de conexão e transmissão permanece fixo; o restante da aplicação não se desloca. Proprietários e administradores acessam as configurações pela engrenagem ao lado do nome da comunidade.

| Área | Funcionalidades |
|---|---|
| Visão geral | Renomear comunidade, enviar imagem ou escolher entre 13 ícones e 8 cores, copiar ou renovar convite e excluir a comunidade com confirmação |
| Canais | Criar canais de texto ou tela, renomear, reordenar e excluir |
| Perfil | Cada usuário envia uma imagem PNG/JPG/WebP de até 2 MB ou escolhe ícone e cor; a mudança aparece em membros e mensagens em tempo real |
| Salas de tela | Scroll próprio no desktop e celular com cabeçalho fixo, múltiplas streams, volume e mudo local, foco com faixa lateral, modos de áudio e perfis Economia 720p/2,5 Mbps, Equilibrado 1080p/5,5 Mbps e Jogo 1080p60/8 Mbps |
| Câmeras | Uma câmera por participante, prévia privada, seleção de dispositivo, espelhamento, enquadramento, foco e perfis 360p/600 Kbps, 720p/1,7 Mbps e 1080p/3,2 Mbps |
| Membros | Consultar presença, ícone e função; proprietários podem promover ou rebaixar administradores; usuários autorizados podem remover membros |
| Segurança | Autorização no servidor para cada operação e bloqueio de ações administrativas para membros comuns |

## Áudio da transmissão

O modo **Janela ou aba** solicita `windowAudio: "window"` e exclui o áudio geral do sistema; o modo **Tela + dispositivo** solicita o áudio do sistema; e **Somente imagem** desativa completamente a captura de áudio. A interface informa a superfície realmente capturada e se o navegador forneceu uma faixa de áudio.

> A aplicação não pode escolher um processo específico nem garantir o áudio isolado de um jogo quando o usuário compartilha o monitor inteiro. O padrão exige que o navegador preserve a escolha do usuário e permite que ele ofereça áudio de janela, aba ou sistema conforme o suporte da plataforma.[1] [2] Para tentar isolar um jogo, o usuário deve escolher a **janela do jogo** no seletor. Chrome 142 ou superior oferece áudio do dispositivo em janelas e telas inteiras no Windows 11 e macOS 14.2 ou superior, mas esse recurso continua sendo áudio do dispositivo, não seleção arbitrária por processo.[3]

## Qualidade e bitrate

O transmissor escolhe o perfil antes de iniciar. **Economia** usa 720p/30 fps com teto de 2,5 Mbps; **Equilibrado** usa 1080p/30 fps com teto de 5,5 Mbps; e **Jogo** solicita 1080p/60 fps com teto de 8 Mbps. Cada perfil publica três camadas de simulcast, enquanto `adaptiveStream`, `dynacast` e o controle de congestionamento continuam reduzindo a camada ou taxa quando necessário.[4] [5]

A sala apresenta o bitrate total enviado, os FPS observados e se a transmissão está limitada por rede ou CPU. A preferência fica salva somente no navegador do usuário. O áudio compartilhado usa o preset estéreo de alta qualidade, RED habilitado e DTX desabilitado.[4]

## Câmeras individuais

Cada participante pode ligar sua própria câmera ou abrir **Configurar** para selecionar o dispositivo, testar uma pré-visualização privada e escolher **Economia** (360p/24 fps, 600 Kbps), **Equilibrada** (720p/30 fps, 1,7 Mbps) ou **Alta definição** (1080p/30 fps, 3,2 Mbps). As preferências de câmera, espelhamento e enquadramento ficam salvas somente no navegador.

As câmeras usam simulcast e adaptação de qualidade, coexistem com compartilhamentos de tela e podem ser focadas no mesmo layout. Ao desligar, a faixa é despublicada e a captura local é encerrada. O navegador solicita permissão apenas quando a prévia ou a publicação é iniciada.[6] [7]

## Componentes

| Serviço | Função |
|---|---|
| `app` | API, autenticação, Socket.IO, persistência SQLite e frontend React |
| `livekit` | SFU WebRTC para publicação e distribuição das telas |
| `caddy` | HTTPS automático e proxy reverso |

## Operação

A implantação é controlada por `docker compose`. O banco e as imagens normalizadas ficam em `./data`, enquanto certificados ficam nos volumes do Caddy. As imagens são convertidas para WebP quadrado de 512 × 512 pixels; substituições e remoções apagam os arquivos anteriores. As credenciais de infraestrutura permanecem em `.env` e `infra/livekit.yaml`, ambos fora do controle de versão.

```bash
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs -f --tail=100
```

## Segurança

As senhas aceitam no mínimo 8 caracteres, sem exigência de maiúsculas, números ou símbolos, e são derivadas com scrypt e salt aleatório. As sessões usam tokens opacos guardados como hash no banco e cookies `HttpOnly`, `Secure` e `SameSite=Lax`. O servidor valida origem, associação à comunidade e permissão de canal antes de mensagens ou tokens WebRTC. Nos uploads, valida tipo declarado e formato real, limita a entrada a 2 MB, restringe a 20 milhões de pixels e recodifica o conteúdo antes de publicá-lo. A prévia da câmera permanece local até confirmação, e desligar a câmera interrompe o dispositivo em vez de apenas ocultar o vídeo.

## Referências

[1]: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia "MDN — MediaDevices.getDisplayMedia()"
[2]: https://www.w3.org/TR/screen-capture/ "W3C — Screen Capture"
[3]: https://workspaceupdates.googleblog.com/2025/12/share-devices-audio-when-presenting.html "Google Workspace Updates — Share your device’s audio when presenting"
[4]: https://docs.livekit.io/transport/media/advanced/ "LiveKit — Codecs and more"
[5]: https://livekit.com/webrtc/bitrate-guide "LiveKit — Bitrate Guide for WebRTC Video"
[6]: https://docs.livekit.io/transport/media/publish/ "LiveKit — Camera & microphone"
[7]: https://docs.livekit.io/transport/media/ "LiveKit — Media overview"

## Zoom do visualizador

Quem assiste a uma transmissão pode controlar o zoom localmente entre 50% e 300%, sem alterar a imagem dos demais participantes nem o bitrate enviado pelo transmissor. Os botões oferecem reduzir, ampliar, tamanho original e ajustar à tela. Com zoom acima de 100%, é possível arrastar a imagem para explorar detalhes; a roda do mouse e as teclas `+`, `-`, `0` e `Esc` também são suportadas. Em dispositivos touch, o visualizador aceita gesto de pinça e arraste. O estado é independente por tile e o botão de foco continua funcionando em conjunto com o zoom.


## Seleção local de compartilhamentos

Quem assiste pode escolher quais compartilhamentos de tela deseja receber. O painel **Compartilhamentos que você assiste** permite ativar ou desativar o vídeo de cada publicação, ouvir o áudio separadamente quando disponível e definir um limite local de 1, 2, 4, 8 ou todas as streams. Quando o vídeo é desativado, o LiveKit cancela a assinatura daquela faixa no espectador; a publicação e o transmissor continuam ativos para os demais usuários. A preferência de limite fica salva no navegador, enquanto seleção e áudio são reaplicados quando a sala reconecta.

A câmera e o microfone permanecem independentes dessa seleção. O foco e o zoom funcionam somente nas mídias de vídeo que o usuário escolheu receber. `adaptiveStream`, `dynacast` e camadas simulcast continuam ativos para ajustar a qualidade daquelas streams que permanecem selecionadas.


## Escala e observabilidade

A sala mantém assinatura seletiva para telas e câmeras remotas. Cada espectador pode limitar localmente a quantidade de vídeos recebidos e desativar faixas desnecessárias; o áudio pode continuar separado. O painel administrativo **Saúde operacional** exibe CPU do app, carga, memória do host, tráfego, sockets, usuários online, telas ativas, câmeras publicadas, áudio, RSS e uptime, com atualização a cada 15 segundos.

A API protegida `GET /api/ops/metrics?communityId=...` permite a consulta apenas por proprietário ou administrador da comunidade. O backend acompanha limites de 24 streams de tela e 16 câmeras publicadas por comunidade, configuráveis por `MAX_ACTIVE_SCREEN_STREAMS` e `MAX_ACTIVE_CAMERA_STREAMS`, e emite `capacity:warning` quando o limite é atingido. Alertas aparecem para dez ou mais mídias ativas, saída acima de 80 Mbps, memória acima de 80% ou carga elevada. A gravação em nuvem permanece desativada nesta versão.


## Rolagem otimizada da sala

A sala de transmissão usa um contêiner vertical próprio com `overflow-y: auto`, `overscroll-behavior: contain`, trilho de scrollbar estável e cabeçalho de controles fixo. O scroll da sala não move o documento, as barras laterais ou o painel de membros. No visualizador, a roda do mouse só altera o zoom quando a stream está ampliada ou quando Ctrl está pressionado; em zoom normal ela permanece disponível para a rolagem da sala. Pan, pinça e arraste continuam locais à transmissão. A interface respeita `prefers-reduced-motion` e usa aceleração de touch no celular.


## Otimização móvel e tela cheia

A sala móvel usa `100dvh`/`100svh`, áreas seguras para notch, rolagem com contenção de overscroll, controles em grade para toque, faixa horizontal com snap no layout focado e suporte à orientação paisagem. Em zoom normal, os tiles permitem rolagem vertical nativa; com zoom acima de 100%, o tile assume o gesto para pan e pinça sem deslocar a sala.

Em telas móveis, vídeos de tiles fora da viewport são pausados localmente por `IntersectionObserver`, usando a sala como raiz. Isso reduz trabalho de composição, CPU e bateria sem despublicar a faixa. A assinatura seletiva continua controlando quais faixas chegam ao cliente.

A sala e cada transmissão de tela possuem botão de tela cheia. O TelaHub usa `requestFullscreen({navigationUI: 'hide'})` quando disponível, acompanha `fullscreenchange`, permite saída pelo botão ou Esc, aplica `100dvh` e `env(safe-area-inset-*)` e mantém zoom, volume e controles visíveis. Quando o navegador não oferece ou rejeita a API nativa, é aplicado um fallback visual no elemento.

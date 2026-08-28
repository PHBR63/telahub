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
| Membros | Consultar presença, ícone e função; proprietários podem promover ou rebaixar administradores; usuários autorizados podem remover membros |
| Segurança | Autorização no servidor para cada operação e bloqueio de ações administrativas para membros comuns |

## Áudio da transmissão

O modo **Janela ou aba** solicita `windowAudio: "window"` e exclui o áudio geral do sistema; o modo **Tela + dispositivo** solicita o áudio do sistema; e **Somente imagem** desativa completamente a captura de áudio. A interface informa a superfície realmente capturada e se o navegador forneceu uma faixa de áudio.

> A aplicação não pode escolher um processo específico nem garantir o áudio isolado de um jogo quando o usuário compartilha o monitor inteiro. O padrão exige que o navegador preserve a escolha do usuário e permite que ele ofereça áudio de janela, aba ou sistema conforme o suporte da plataforma.[1] [2] Para tentar isolar um jogo, o usuário deve escolher a **janela do jogo** no seletor. Chrome 142 ou superior oferece áudio do dispositivo em janelas e telas inteiras no Windows 11 e macOS 14.2 ou superior, mas esse recurso continua sendo áudio do dispositivo, não seleção arbitrária por processo.[3]

## Qualidade e bitrate

O transmissor escolhe o perfil antes de iniciar. **Economia** usa 720p/30 fps com teto de 2,5 Mbps; **Equilibrado** usa 1080p/30 fps com teto de 5,5 Mbps; e **Jogo** solicita 1080p/60 fps com teto de 8 Mbps. Cada perfil publica três camadas de simulcast, enquanto `adaptiveStream`, `dynacast` e o controle de congestionamento continuam reduzindo a camada ou taxa quando necessário.[4] [5]

A sala apresenta o bitrate total enviado, os FPS observados e se a transmissão está limitada por rede ou CPU. A preferência fica salva somente no navegador do usuário. O áudio compartilhado usa o preset estéreo de alta qualidade, RED habilitado e DTX desabilitado.[4]

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

As senhas aceitam no mínimo 8 caracteres, sem exigência de maiúsculas, números ou símbolos, e são derivadas com scrypt e salt aleatório. As sessões usam tokens opacos guardados como hash no banco e cookies `HttpOnly`, `Secure` e `SameSite=Lax`. O servidor valida origem, associação à comunidade e permissão de canal antes de mensagens ou tokens WebRTC. Nos uploads, valida tipo declarado e formato real, limita a entrada a 2 MB, restringe a 20 milhões de pixels e recodifica o conteúdo antes de publicá-lo.

## Referências

[1]: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia "MDN — MediaDevices.getDisplayMedia()"
[2]: https://www.w3.org/TR/screen-capture/ "W3C — Screen Capture"
[3]: https://workspaceupdates.googleblog.com/2025/12/share-devices-audio-when-presenting.html "Google Workspace Updates — Share your device’s audio when presenting"
[4]: https://docs.livekit.io/transport/media/advanced/ "LiveKit — Codecs and more"
[5]: https://livekit.com/webrtc/bitrate-guide "LiveKit — Bitrate Guide for WebRTC Video"

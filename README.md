# TelaHub

TelaHub é um aplicativo web instalável para comunicação em equipes, com autenticação própria, comunidades, canais de texto persistentes, presença em tempo real e salas de compartilhamento de tela usando LiveKit/WebRTC.

## Recursos

A interface possui rolagem independente para canais, mensagens, membros, salas e configurações, mantendo cabeçalhos e controles essenciais fixos. Proprietários e administradores acessam as configurações pela engrenagem ao lado do nome da comunidade.

| Área | Funcionalidades |
|---|---|
| Visão geral | Renomear comunidade, escolher entre 13 ícones e 8 cores, copiar ou renovar convite e excluir a comunidade com confirmação |
| Canais | Criar canais de texto ou tela, renomear, reordenar e excluir |
| Perfil | Cada usuário escolhe seu ícone e sua cor pelo cartão de perfil; a mudança aparece em membros e mensagens em tempo real |
| Membros | Consultar presença, ícone e função; proprietários podem promover ou rebaixar administradores; usuários autorizados podem remover membros |
| Segurança | Autorização no servidor para cada operação e bloqueio de ações administrativas para membros comuns |

## Componentes

| Serviço | Função |
|---|---|
| `app` | API, autenticação, Socket.IO, persistência SQLite e frontend React |
| `livekit` | SFU WebRTC para publicação e distribuição das telas |
| `caddy` | HTTPS automático e proxy reverso |

## Operação

A implantação é controlada por `docker compose`. Os dados persistentes ficam em `./data`, enquanto certificados ficam nos volumes do Caddy. As credenciais de infraestrutura permanecem em `.env` e `infra/livekit.yaml`, ambos fora do controle de versão.

```bash
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs -f --tail=100
```

## Segurança

As senhas aceitam no mínimo 8 caracteres, sem exigência de maiúsculas, números ou símbolos, e são derivadas com scrypt e salt aleatório. As sessões usam tokens opacos guardados como hash no banco e cookies `HttpOnly`, `Secure` e `SameSite=Lax`. O servidor valida origem, associação à comunidade e permissão de canal antes de mensagens ou tokens WebRTC.

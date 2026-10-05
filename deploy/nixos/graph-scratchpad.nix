# Graph Scratchpad on a NixOS host: the static app plus the sync server, one
# Node process (nodejs from nixpkgs), published on the tailnet over HTTPS by
# `tailscale serve`. Releases are pushed by `npm run deploy:pi` into
# ${root}/releases/<stamp> with ${root}/current pointing at the live one, so
# app updates don't need a rebuild; this module only provides the runtime.
#
# Usage, in the host's configuration:
#   imports = [ ../../modules/system/graph-scratchpad.nix ];
#   services.graph-scratchpad.enable = true;
{ config, lib, pkgs, ... }:

let
  cfg = config.services.graph-scratchpad;
  root = cfg.dataDir;
in
{
  options.services.graph-scratchpad = {
    enable = lib.mkEnableOption "Graph Scratchpad (static app and sync server)";

    user = lib.mkOption {
      type = lib.types.str;
      default = "vcavallo";
      description = "Account that runs the server and owns the releases (deploys rsync in as this user).";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8742;
      description = "Local port; the server listens on 127.0.0.1 only.";
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/graph-scratchpad";
      description = "Releases, and the sync database (sync/) with its daily backups.";
    };

    tailnetHttpsPort = lib.mkOption {
      type = lib.types.nullOr lib.types.port;
      default = 443;
      description = "Publish on the tailnet at https://<host>.<tailnet>.ts.net:<port> (null: don't).";
    };

    anthropicKeyFile = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.dataDir}/anthropic-api-key";
      description = ''
        File holding an Anthropic API key (mode 600, owned by the service user). If it
        exists, the server labels links with Claude Haiku; otherwise devices keep their
        own guesses. Kept out of the Nix store on purpose.
      '';
    };

    nodejs = lib.mkPackageOption pkgs "nodejs_22" { };
  };

  config = lib.mkIf cfg.enable {
    systemd.tmpfiles.rules = [
      "d ${root} 0755 ${cfg.user} users -"
      "d ${root}/releases 0755 ${cfg.user} users -"
      "d ${root}/sync 0700 ${cfg.user} users -"
    ];

    systemd.services.graph-scratchpad = {
      description = "Graph Scratchpad (static app + sync)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      # Nothing to serve until the first deploy; don't fail the rebuild over it.
      unitConfig.ConditionPathExists = "${root}/current/server/serve.mjs";
      environment = {
        HOST = "127.0.0.1";
        PORT = toString cfg.port;
        SYNC_DB = "${root}/sync/sync.sqlite3";
        SYNC_NAME = config.networking.hostName;
        RELATIONS_KEY_FILE = cfg.anthropicKeyFile;
        NODE_NO_WARNINGS = "1"; # node:sqlite is still marked experimental
      };
      serviceConfig = {
        User = cfg.user;
        ExecStart = "${cfg.nodejs}/bin/node ${root}/current/server/serve.mjs ${root}/current/app";
        Restart = "always";
        RestartSec = 3;
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ root ];
      };
    };

    systemd.services.graph-scratchpad-tailnet = lib.mkIf (cfg.tailnetHttpsPort != null) {
      description = "Publish Graph Scratchpad on the tailnet";
      wantedBy = [ "multi-user.target" ];
      after = [ "tailscaled.service" ];
      wants = [ "tailscaled.service" ];
      path = [ config.services.tailscale.package ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      # tailscaled may still be logging in at boot; wait for it.
      script = ''
        for i in $(seq 60); do
          tailscale status >/dev/null 2>&1 && break
          sleep 2
        done
        tailscale serve --bg --https=${toString cfg.tailnetHttpsPort} http://127.0.0.1:${toString cfg.port}
      '';
    };
  };
}

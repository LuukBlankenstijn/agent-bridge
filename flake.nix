{
  description = "agent-bridge: peer-to-peer mailbox for AI agents, exposed over MCP";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.stdenv.mkDerivation (finalAttrs: {
          pname = "agent-bridge";
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          src = self;
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            fetcherVersion = 5;
            hash = "sha256-DQ8JHEIhnM3pquW8mn5BzQT3vfnepcnDNJzQtt0LLOs=";
          };
          nativeBuildInputs = [
            pkgs.nodejs
            pkgs.pnpm
            pkgs.pnpmConfigHook
            pkgs.makeWrapper
          ];
          buildPhase = ''
            runHook preBuild
            pnpm build
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/agent-bridge
            cp -r package.json dist node_modules $out/lib/agent-bridge/
            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/agent-bridge \
              --add-flags $out/lib/agent-bridge/dist/src/bin.js
            runHook postInstall
          '';
          meta.mainProgram = "agent-bridge";
        });
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            pkgs.pnpm
          ];
        };
      });
    };
}

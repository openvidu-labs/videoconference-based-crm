{ pkgs ? import (fetchTarball "https://github.com/NixOS/nixpkgs/archive/nixos-24.11.tar.gz") {} }:

pkgs.mkShell {
  buildInputs = [
    pkgs.nodejs_22
  ];

  shellHook = ''
    echo "⚡ Node.js 22 Nix development shell activated!"
    node --version
  '';
}
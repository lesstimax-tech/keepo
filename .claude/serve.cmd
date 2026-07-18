@echo off
rem Serveur statique local pour KEEPO (laptop E:\Keepo).
rem Necessite Node.js installe et dans le PATH (npx).
cd /d E:\Keepo
npx -y http-server -p 3000 -c-1 --silent

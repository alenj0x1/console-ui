[English](CHANGELOG.md) | Español

# Registro de cambios

Aquí se documentan los cambios importantes del proyecto. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

Los cambios que esperan la próxima versión van en **Sin publicar**, arriba (esa sección solo existe mientras haya alguno y el sitio de documentación no la muestra); `scripts/release.py` la convierte en la versión nueva.

## [Sin publicar]

### Agregado

- Núcleo de entrada del control (XInput, leído en segundo plano) con cursor, scroll, clics, arrastre, flechas, Esc, atrás/adelante, vista de tareas y menú Inicio.
- Cursor asistido: aceleración predecible, frenado sobre elementos clicables (UI Automation, solo al apuntar) y clic estable.
- Modo juego: mantener View + Menu para dejarle el control a los juegos y volver, con vibración.
- App Tauri con ícono en la bandeja y un teclado en pantalla que nunca quita el foco (Y lo abre, B lo cierra).
- Diseños de teclado: cuadrícula QWERTY con ñ, tildes manteniendo el botón y símbolos; dos mitades como opción.
- Sugerencias de palabras con tildes, contexto de la palabra anterior y predicción de la siguiente; español por defecto, inglés desde la tecla de idiomas (L3).
- Palabras aprendidas, cifradas con DPAPI y apagadas en campos de contraseña; «Olvidar palabras aprendidas» en el menú de idiomas.
- Laboratorios del cursor y del teclado con sus datos y notas.

[English](CHANGELOG.md) | Español

# Registro de cambios

Aquí se documentan los cambios importantes del proyecto. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

Los cambios que esperan la próxima versión van en **Sin publicar**, arriba (esa sección solo existe mientras haya alguno y el sitio de documentación no la muestra); `scripts/release.py` la convierte en la versión nueva.

## [Sin publicar]

### Agregado

- Núcleo de entrada del control (XInput, leído en segundo plano) con cursor, scroll, clics, arrastre, flechas, Esc, atrás/adelante, vista de tareas y menú Inicio.
- Cursor asistido: aceleración predecible, frenado sobre elementos clicables (UI Automation, solo al apuntar) y clic estable.
- Modo juego: mantener View + Menu para dejarle el control a los juegos y volver, con vibración.
- App Tauri con ícono en la bandeja y un teclado en pantalla que nunca quita el foco (Y lo abre, B lo cierra). Al abrir la app aparece Inicio (`--background` la inicia en silencio); el clic en el ícono de la bandeja también lo abre, y su menú abre el teclado o deja el control a los juegos.
- Diseños de teclado: cuadrícula QWERTY con ñ, tildes manteniendo el botón y símbolos; dos mitades como opción.
- Sugerencias de palabras con tildes, contexto de la palabra anterior y predicción de la siguiente; español por defecto, inglés desde la tecla de idiomas (L3).
- Palabras aprendidas, cifradas con DPAPI y apagadas en campos de contraseña; «Olvidar palabras aprendidas» en el menú de idiomas.
- Pantalla de Inicio (mantener Menu): juegos instalados de Steam y Epic con su arte oficial de Steam de fondo, apps fijadas del menú Inicio con sus íconos reales y un reproductor de música (portada y su color de fondo, progreso, botones redondos). Arriba/abajo cambian el volumen del sistema e Y silencia. Al abrir un juego, el control pasa a él.
- Fondos para Inicio, elegidos desde «Fondo» en Apps con vista previa en vivo: cinco fondos animados propios dibujados por la GPU (Ola diagonal por defecto, Ondas, Lluvia, Respiración y Ondas lineales), los fondos de video de Wallpaper Engine (con acceso a su Workshop) y los videos e imágenes de Videos, Imágenes o cualquier carpeta que se agregue con el control. El arte del juego enfocado aparece encima en Juegos (se puede apagar); el fondo se pausa cuando no se ve.
- Tráileres en Juegos: tras unos segundos sobre un juego de Steam, su tráiler aparece sobre el arte en silencio y en bucle (los primeros segundos, descargados de la tienda de Steam una vez y guardados).
- Música: el fondo combina los dos colores principales de la portada, y las portadas que llegan como tarjeta con el logo del reproductor se recortan a la carátula.
- Spotify Web dentro de la app («Abrir Spotify» en Música), para cuentas gratis y Premium: la sesión se inicia en la página de Spotify, la ventana no tiene acceso a la app y guarda sus datos aparte.
- Volumen desde cualquier lugar: mantener RT y usar la cruceta (arriba/abajo volumen, izquierda/derecha canción anterior/siguiente).
- Con HidHide instalado, las demás apps dejan de ver el control mientras maneja Windows (el menú Inicio y otras apps de la Tienda ya no mueven su propio foco ni saltan) y lo vuelven a ver en modo juego; un guardián lo vuelve a mostrar si la app se cierra de golpe.
- Ventanas de administrador: Windows bloquea ahí las entradas de una app normal, así que un aviso explica por qué el control no responde y B devuelve el foco a la siguiente ventana normal (Console UI no sube sus propios permisos).
- Registro de eventos para diagnóstico en la carpeta de datos de la app (cambios de modo, lo que se abre y en qué programa escribe el teclado; nunca el texto).
- Laboratorios del cursor y del teclado con sus datos y notas.

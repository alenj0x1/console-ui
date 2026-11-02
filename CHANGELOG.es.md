[English](CHANGELOG.md) | Español

# Registro de cambios

Aquí se documentan los cambios importantes del proyecto. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

Los cambios que esperan la próxima versión van en **Sin publicar**, arriba (esa sección solo existe mientras haya alguno y el sitio de documentación no la muestra); `scripts/release.py` la convierte en la versión nueva.

## [Sin publicar]

### Agregado

- Núcleo de entrada del control (XInput, leído en segundo plano) con cursor, scroll, clics, arrastre, flechas, Esc, atrás/adelante, vista de tareas y menú Inicio.
- Cursor asistido: aceleración predecible, frenado sobre elementos clicables (UI Automation, solo al apuntar) y clic estable.
- Modo juego: cuando un juego pasa al frente (desde cualquier lado), el control es suyo, con vibración y un aviso breve, y el cursor vuelve cuando se cierra. Si recuperas el control desde la bandeja, ese juego queda tranquilo.
- Guía (mantener View + Menu, incluso en un juego; un toque de View en el escritorio): ventanas abiertas con una imagen de cada una; A cambia a una (un juego recibe el control; lo demás, el cursor), Y cierra una, X / LT / RT manejan la música y B vuelve. Nunca toma el foco, así que el juego sigue al frente.
- App Tauri con ícono en la bandeja y un teclado en pantalla que nunca quita el foco (Y o un clic en un campo de texto lo abre, B lo cierra). Se abre en el monitor donde está el cursor y pasa arriba si taparía lo que se escribe. Al abrir la app aparece Inicio (`--background` la inicia en silencio); el clic en el ícono de la bandeja también lo abre, y su menú abre el teclado o deja el control a los juegos.
- Diseños de teclado: cuadrícula QWERTY con ñ, tildes manteniendo el botón y símbolos; dos mitades como opción.
- Sugerencias de palabras con tildes, contexto de la palabra anterior y predicción de la siguiente; español por defecto, inglés desde la tecla de idiomas (L3).
- Palabras aprendidas, cifradas con DPAPI y apagadas en campos de contraseña; «Olvidar palabras aprendidas» en el menú de idiomas.
- Pantalla de Inicio (mantener Menu): juegos instalados de Steam y Epic con su arte oficial de Steam de fondo, apps fijadas del menú Inicio con sus íconos reales y una pestaña Multimedia con tus apps de música y video instaladas (Spotify, VLC…) y lo que agregues desde «Editar» (primero las apps de medios; las demás, en «Todas las apps»), o YouTube, YouTube Music, Netflix, Twitch, Prime Video y Disney+, que se abren en tu navegador predeterminado, con tu sesión. La app que está sonando va primero con la canción en su tarjeta; con el foco en ella, el fondo toma el color de la portada y muestra el progreso, X pausa o reanuda y LT / RT cambian de canción. Arriba/abajo cambian el volumen del sistema e Y silencia. Al abrir un juego, el control pasa a él.
- Fondos para Inicio, elegidos desde «Fondo» en Apps con vista previa en vivo: cinco fondos animados propios dibujados por la GPU (Ola diagonal por defecto, Ondas, Lluvia, Respiración y Ondas lineales), los fondos de video de Wallpaper Engine (con acceso a su Workshop) y los videos e imágenes de Videos, Imágenes o cualquier carpeta que se agregue con el control. El arte del juego enfocado aparece encima en Juegos (se puede apagar); el fondo se pausa cuando no se ve.
- Pestaña Ajustes en Inicio, manejada con el control, con nombres en palabras de todos los días y una descripción por opción. Apariencia (color principal, tamaño de letra, marco de selección más grueso, fondo e imágenes de los juegos), Botones (aceptar con B, puntero con la palanca derecha, tiempo para mantener presionado), Puntero (velocidad, ayuda para apuntar, ignorar movimientos pequeños, velocidad al desplazar y desplazar al revés), Teclado (forma, sugerir palabras, recordar mis palabras, idiomas y borrar palabras recordadas), Juegos (dejar el control al juego que abras) y General (iniciar con Windows en la bandeja, vibrar al cambiar de modo y forma de este menú, en lista o en cuadros). Los cambios se aplican al instante en todas las ventanas.
- Al activar aceptar con B o el puntero con la palanca derecha, la app pregunta si dejas el cambio y vuelve sola a como estaba a los 10 segundos sin respuesta.
- «Dejar todo como venía», en General, vuelve todas las opciones a como venían (las apps fijadas, Multimedia y las palabras aprendidas se quedan); pide una segunda pulsación antes.
- Los botones del control se dibujan como en el control en toda la app (A, B, X, Y, L3 y R3 redondos, bumpers y gatillos con su forma, Vista y Menú con su símbolo), también dentro de las descripciones de Ajustes.
- Las opciones de Puntero y Botones muestran al lado una vista previa animada de lo que cambian, hecha con los mismos valores que el control, con el valor anterior en tenue para comparar y una línea que explica el valor elegido. Mientras Ajustes está abierto, el fondo se atenúa.
- Tráileres en Juegos: tras unos segundos sobre un juego de Steam, su tráiler aparece sobre el arte en silencio y en bucle (los primeros segundos, descargados de la tienda de Steam una vez y guardados).
- Multimedia: el fondo combina los dos colores principales de la portada, y las portadas que llegan como tarjeta con el logo del reproductor se recortan a la carátula.
- Los indicadores de View y Menu muestran el símbolo impreso en esos botones en lugar de su nombre.
- Un toque en RT envía Intro (para enviar tras cerrar el teclado).
- Volumen desde cualquier lugar: mantener RT y usar la cruceta (arriba/abajo volumen, izquierda/derecha canción anterior/siguiente).
- Con HidHide instalado, las demás apps dejan de ver el control mientras maneja Windows (el menú Inicio y otras apps de la Tienda ya no mueven su propio foco ni saltan) y lo vuelven a ver en modo juego; un guardián lo vuelve a mostrar si la app se cierra de golpe.
- Ventanas de administrador: Windows bloquea ahí las entradas de una app normal, así que un aviso explica por qué el control no responde y B devuelve el foco a la siguiente ventana normal (Console UI no sube sus propios permisos).
- Registro de eventos para diagnóstico en la carpeta de datos de la app (cambios de modo, lo que se abre y en qué programa escribe el teclado; nunca el texto).
- Laboratorios del cursor y del teclado con sus datos y notas.

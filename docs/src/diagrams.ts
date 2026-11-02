// Data for the docs diagrams (components/Diagram.astro), shared by the English and Spanish pages.
type Lang = 'en' | 'es';
const t = (lang: Lang, en: string, es: string) => (lang === 'es' ? es : en);

// The input core: the controller goes in, the mode decides where it goes.
export const inputCore = (lang: Lang) => ({
  label: t(lang,
    'The input core reads the controller and, depending on the mode, moves the pointer and presses keys in Windows, sends navigation to the keyboard, Home or the control center, or leaves the controller to the game. A screen reader-style probe tells it whether the pointer is over something clickable.',
    'El núcleo de entrada lee el control y, según el modo, mueve el puntero y presiona teclas en Windows, manda la navegación al teclado, a Inicio o al centro de control, o deja el control al juego. Una consulta de accesibilidad le dice si el puntero está sobre algo que se puede pulsar.'),
  groups: [
    { x: 10, y: 190, w: 460, h: 185, title: 'Console UI', icon: 'app-window' },
  ],
  nodes: [
    { id: 'pad', x: 240, y: 55, icon: 'device-gamepad-2', label: t(lang, 'Controller', 'Control') },
    { id: 'uia', x: 0, y: 280, before: 'core', icon: 'accessible', label: t(lang, 'Screen\nelements', 'Elementos\nde pantalla') },
    { id: 'core', x: 240, y: 280, icon: 'cpu', label: t(lang, 'Input core', 'Núcleo de\nentrada') },
    { id: 'pages', x: 0, y: 280, after: 'core', icon: 'keyboard', label: t(lang, 'Keyboard,\nHome and\ncontrol center', 'Teclado,\nInicio y centro\nde control') },
    { id: 'win', x: 240, y: 510, icon: 'brand-windows', label: t(lang, 'Windows: pointer\nand keys', 'Windows: puntero\ny teclas') },
  ],
  edges: [
    { from: 'pad', to: 'core', label: t(lang, 'read in the background', 'lectura en segundo plano') },
    { from: 'uia', to: 'core', dashed: true },
    { from: 'core', to: 'pages' },
    { from: 'core', to: 'win', label: t(lang, 'pointer mode', 'modo puntero') },
  ],
});

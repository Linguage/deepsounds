window.__ModuleLoader__.load({
  id: 'deepsounds-dsh',
  factory: require => {
    const { createElement: h, useLayoutEffect, useRef, useState } = require('react');
    const id = 'deepsounds';
    const path = '/deepsounds/';
    const title = id;
    const size = { width: '100%', height: '100%', minHeight: 0, minWidth: 0 };
    const frameProps = { src: path, title, allowFullScreen: true, style: { ...size, border: 0, display: 'block' } };
    function Icon({ size = 20 } = {}) {
      return h('img', { src: path + 'icon.svg', alt: '', width: size, height: size });
    }
    return {
      isPlugin: true, name: id, inject: ['slots'],
      apply(ctx) {
        const canMove = typeof Element.prototype.moveBefore === 'function';
        let parking;
        let frame;
        let mainMount;
        const sideMounts = new Map();
        const setParking = node => { parking = node; };

        function Parking() {
          return h('div', { ref: setParking, hidden: true });
        }

        function placeFrame() {
          const visible = mainMount ?? [...sideMounts.keys()].at(-1);
          const target = visible ?? parking;
          if (!target?.isConnected) return;
          if (!frame && visible) {
            frame = document.createElement('iframe');
            frame.src = frameProps.src;
            frame.title = frameProps.title;
            frame.allowFullscreen = frameProps.allowFullScreen;
            Object.assign(frame.style, frameProps.style);
          }
          if (!frame || frame.parentNode === target) return;
          const previous = frame.parentNode;
          // Preserve the document and playback when DSH changes panels or tabs.
          if (frame.isConnected) target.moveBefore(frame, null);
          else target.append(frame);
          sideMounts.get(previous)?.(false);
          sideMounts.get(target)?.(true);
        }

        function FrameMount({ side = false, active = true }) {
          const mount = useRef(null);
          const [hasFrame, setHasFrame] = useState(false);
          useLayoutEffect(() => {
            const target = mount.current;
            if (!target || !active) return;
            if (side) {
              setHasFrame(frame?.parentNode === target);
              sideMounts.set(target, setHasFrame);
            }
            else mainMount = target;
            placeFrame();
            return () => {
              if (side) sideMounts.delete(target);
              if (!side && mainMount === target) mainMount = null;
              placeFrame();
            };
          }, [active, side]);
          if (!canMove) return active ? h('iframe', frameProps) : null;
          const bringHere = () => {
            const target = mount.current;
            if (!sideMounts.delete(target)) return;
            sideMounts.set(target, setHasFrame);
            placeFrame();
          };
          return h('div', { ref: mount, style: size }, side && active && !hasFrame && h('button', {
            type: 'button', onClick: bringHere, style: { margin: 12, padding: '6px 10px', cursor: 'pointer' },
          }, '在此显示播放器'));
        }

        function Sidebar({ useTabInfo }) {
          const { tab } = useTabInfo();
          return h(FrameMount, { side: true, active: tab.visible });
        }

        if (canMove) {
          ctx.effect(() => () => {
            frame?.remove();
            frame = undefined;
          });
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay', id,
          }, Parking));
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id, order: 69, label: () => title,
        }, Icon));
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id }, FrameMount));
        ctx.inject(['sidebarRightTabs'], scope => {
          scope.effect(() => scope.sidebarRightTabs.register({
            id, kind: id, title: () => title,
            guide: [{ id, title: () => title, description: () => '音乐、播客与 B 站视频', icon: Icon }],
          }));
          scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab', key: id,
          }, Sidebar));
        });
      },
    };
  },
});

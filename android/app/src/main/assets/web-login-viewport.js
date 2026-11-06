(() => {
  // A frame's innerHeight describes the frame itself, not the sign-in viewport.
  if (window.top !== window) return;

  const viewportHeightProperty = '--agents-anywhere-android-viewport-height';
  const collapsedContainerAttribute = 'data-agents-anywhere-android-viewport-container';
  const installViewportHeightFix = () => {
    const root = document.documentElement;
    if (!root) {
      window.setTimeout(installViewportHeightFix, 0);
      return;
    }

    const style = document.createElement('style');
    style.textContent = `
      html, body, .pf-c-login, .pf-c-background-image,
      body > div[${collapsedContainerAttribute}],
      .pf-c-login__container[${collapsedContainerAttribute}],
      .pf-c-login__main[${collapsedContainerAttribute}] {
        min-height: var(${viewportHeightProperty}) !important;
      }
      .h-dvh {
        height: var(${viewportHeightProperty}) !important;
      }
      .min-h-screen {
        min-height: var(${viewportHeightProperty}) !important;
      }
    `;
    root.appendChild(style);

    const repairCollapsedContainers = () => {
      const containers = document.querySelectorAll(
        'body > div, .pf-c-login__container, .pf-c-login__main',
      );
      for (const container of containers) {
        // Preserve content-sized cards, headers, empty mounts and hidden panels.
        // Keep the existing fallback for visible containers clipping real content.
        if (container.clientHeight !== 0 || container.hasAttribute(collapsedContainerAttribute)) continue;
        const computed = window.getComputedStyle(container);
        if (computed.display === 'none' || computed.visibility === 'hidden') continue;
        // Zero-height overlay anchors deliberately let their content overflow.
        // Only repair a generic root when it actually clips the login content.
        if (computed.overflowY === 'visible'
          && !container.matches('.pf-c-login__container, .pf-c-login__main')) continue;
        // Percentage-sized descendants can also be zero until their parent recovers.
        // Custom elements may keep their form inside an inaccessible shadow root.
        const hasContent = container.scrollHeight > 0
          || [...container.querySelectorAll('*')].some(child => {
            if (child.getClientRects().length === 0
              || window.getComputedStyle(child).visibility === 'hidden') return false;
            return child.getBoundingClientRect().height > 0 || child.localName.includes('-');
          });
        if (!hasContent) continue;
        // Use stylesheet priority, preserving the page's explicit inline !important rules.
        container.setAttribute(collapsedContainerAttribute, '');
      }
    };

    const updateViewportHeight = () => {
      const height = window.visualViewport?.height
        || document.documentElement?.clientHeight
        || window.innerHeight
        || 0;
      if (height > 0) {
        root.style.setProperty(viewportHeightProperty, `${Math.round(height)}px`);
      }
      repairCollapsedContainers();
    };
    updateViewportHeight();
    window.addEventListener('resize', updateViewportHeight);
    window.visualViewport?.addEventListener('resize', updateViewportHeight);
    document.addEventListener('DOMContentLoaded', updateViewportHeight, { once: true });
    window.addEventListener('load', updateViewportHeight, { once: true });
    // An IdP can insert its login form after the initial document and delayed samples.
    new MutationObserver(repairCollapsedContainers).observe(root, {
      childList: true, subtree: true, attributes: true,
    });
    // Some WebViews gain a nonzero viewport after layout without a resize event.
    window.setTimeout(updateViewportHeight, 250);
    window.setTimeout(updateViewportHeight, 1200);
  };

  try {
    installViewportHeightFix();
  } catch {
    // Layout recovery must not interrupt the page's own authentication scripts.
  }
})();

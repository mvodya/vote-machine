# Interface and browser review

The support target is the current and previous stable Chrome, Edge, Firefox and Safari
It includes Chrome on Android and Safari on iPhone
A browser must support JavaScript, secure contexts, Web Crypto, fetch streams and modern CSS
Production uses HTTPS, localhost is suitable for development
Source video codecs still depend on browser playback support

The automated matrix uses Chromium desktop and phone sizes, Firefox, WebKit desktop and phone sizes
The phone checks include a 320-pixel viewport and touch-capable WebKit
Engine tests are not a claim that every physical device and previous branded browser release was tested
Actual supported release/device spot checks remain part of release acceptance

## Accessibility

Our own tabs link controls and panels with stable IDs and names
Arrow keys wrap through tabs, Home and End choose the first and last tab
Only the active panel is in the tab order, editor content can retain its local state while hidden
Native controls keep connected labels, hints and errors
Modal confirmation focuses Cancel, traps Tab and Shift+Tab, supports Escape and restores its opener
An async opener passes its ref so disabling it during a request cannot lose return focus
Participant actions focus the resulting panel, background live snapshots do not steal focus

Inactive switches, question links and placeholders have stronger readable colors in both themes
The shared header keeps branding, theme and sound controls consistent on normal and error pages
404 and unexpected rendering errors use short Russian text and a safe way back or retry
The room timezone remains shared across admin and participant devices
Cross-device checks use a New York browser with a Vladivostok room and verify a date crossing midnight

Axe checks the home, empty room, settings, confirmation, question editor/settings/management,
participant answer/history/completion, projector and denied/missing pages
Keyboard checks cover create, tab selection, panel entry, modal focus, answer submission and review close
The deliberately faint noninteractive version footer is excluded from axe per the owner's explicit design
This is not a WCAG conformance certificate, automated checks do not replace assistive-technology/device review
Reduced motion, sound off by default and initial theme selection remain supported

See [Playwright accessibility checks](https://playwright.dev/docs/accessibility-testing),
[WAI tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) and
[WAI modal dialogs](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)

## Running the checks

Install the pinned workspace dependencies and Playwright browsers
On Linux use pnpm --filter @vote-machine/web exec playwright install --with-deps chromium firefox webkit
Run sh tests/test-stack.sh for all real API, browser and outage checks

The downloaded macOS Firefox build failed to open a new profile on this host
FIREFOX_IN_DOCKER=1 sh tests/test-stack.sh uses the pinned official Linux Firefox image instead
The helper runs on a real loopback origin so secure browser APIs behave as they do in local development
It joins only the disposable test network and writes results to apps/web/test-results/firefox-linux
CI installs and runs all three engines directly on Linux

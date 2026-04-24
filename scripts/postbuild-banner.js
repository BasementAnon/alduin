#!/usr/bin/env node

/**
 * Post-build banner — prints ASCII art ALDUIN logo, Terms of Service,
 * and next-step instructions after a successful `npm run build`.
 */

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const CYAN  = '\x1b[36m';
const WHITE = '\x1b[37m';

const banner = `
${BOLD}${CYAN}     ___    __    ____  __  __ __ _   __
    /   |  / /   / __ \\/ / / //  | / /
   / /| | / /   / / / / / / // /||/ /
  / ___ |/ /___/ /_/ / /_/ // / |  /
 /_/  |_/_____/_____/\\____//_/  |_/${RESET}

${DIM}By installing or using Alduin, you agree to the
Terms of Service available at ${WHITE}https://alduin.app/terms${RESET}

${BOLD}To continue setup, run:${RESET}  alduin init
`;

console.log(banner);

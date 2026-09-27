import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://sandbarsdk.dev',
  output: 'static',
  integrations: [starlight({
    title: 'Sandbar',
    description: 'Development documentation for the provider-neutral sandbox API.',
    favicon: '/favicon.svg',
    head: [{ tag: 'meta', attrs: { name: 'robots', content: 'noindex, nofollow' } }],
    social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/pandemicsyn/sandbar' }],
    customCss: ['./src/styles/docs.css'],
    sidebar: [
      { label: 'Start', items: [{ slug: 'docs' }, { slug: 'docs/direct-quickstart' }, { slug: 'docs/service-quickstart' }, { slug: 'docs/choose-a-mode' }] },
      { label: 'Guides', items: [{ autogenerate: { directory: 'docs/guides' } }] },
      { label: 'Reference', items: [{ slug: 'docs/reference/typescript' }, { slug: 'docs/reference/http' }] },
      { label: 'Operate', items: [{ autogenerate: { directory: 'docs/self-hosting' } }, { autogenerate: { directory: 'docs/providers' } }] },
      { label: 'Contribute', items: [{ autogenerate: { directory: 'docs/contributing' } }] },
    ],
  })],
});

// MarkdownRenderer.tsx
import Markdown from 'markdown-to-jsx'
import { BrowserOpenURL } from '@wails/runtime/runtime'
import { ExternalLinkIcon } from 'lucide-react'

type Props = {
    markdown: string
}

export const MarkdownRenderer = ({ markdown }: Props) => {
    return (
        <Markdown
            options={{
                overrides: {
                    a: {
                        component: ({ href, children, ...props }) => (
                            <span className='inline-flex gap-0 items-center'>
                                <a
                                    {...props}
                                    href="#"
                                    onClick={() => href && BrowserOpenURL(href)}
                                    className='text-orange-400'
                                >
                                    {children}
                                </a>
                                <ExternalLinkIcon className='h-4 text-gray-400' strokeWidth={1.5} />
                            </span>
                        )
                    },

                }
            }}
        >
            {markdown}
        </Markdown>
    )
}

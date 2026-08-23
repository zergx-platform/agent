import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'

if (!window.location.hash) window.location.hash = '#/'

const target = document.getElementById('app')
if (!target) throw new Error('#app element not found')
mount(App, { target })

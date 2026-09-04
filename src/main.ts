import { Game } from './game'

const root = document.getElementById('app')
if (!root) throw new Error('missing #app root')
const game = new Game(root)
game.start()

if (import.meta.env.DEV) {
  ;(window as unknown as { __prattlefield: Game }).__prattlefield = game
}

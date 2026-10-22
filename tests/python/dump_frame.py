import sys
sys.stdout.reconfigure(encoding="utf-8")
import asyncio, sys
sys.path.insert(0, sys.argv[1])
from ui import Ui, MyApp
async def main():
    ui = Ui(); app = MyApp(ui=ui)
    async with app.run_test(size=(100, 40)) as pilot:
        from ui_runtime import StudioScreen
        for _ in range(100):
            if isinstance(app.screen, StudioScreen): break
            await asyncio.sleep(0.02)
        await pilot.pause()
        for strip in app.screen._compositor.render_strips():
            print(''.join(s.text for s in strip).rstrip())
asyncio.run(main())

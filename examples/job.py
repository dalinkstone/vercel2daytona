import asyncio

from vercel2daytona import sandbox


async def main():
    async with sandbox.create_sandbox(persistent=False) as box:
        await box.fs.write_text("hello.txt", "hello from Daytona")
        result = await box.run_process(
            "python", ["-c", "print(open('hello.txt').read())"],
            capture_output=True, check=True,
        )
        print(result.stdout, end="")


if __name__ == "__main__":
    asyncio.run(main())

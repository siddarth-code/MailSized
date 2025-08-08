from setuptools import setup

setup(
    name='mailsized',
    version='0.1',
    install_requires=[
        'fastapi',
        'uvicorn',
        'python-multipart',
        'python-dotenv',
        'requests'
    ],
)
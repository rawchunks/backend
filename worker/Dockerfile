FROM us-east1-docker.pkg.dev/gen-lang-client-0035632562/compose/acestep-xl-15@sha256:1b1b512f896279c6b04e01e4d4529b95ecad5749f69b8c3b1cd6c206734302ab

COPY overlay /tmp/rawchunks-overlay
COPY source.json /tmp/rawchunks-source.json
COPY patch.py /tmp/rawchunks-patch.py
RUN python3 /tmp/rawchunks-patch.py && rm -r /tmp/rawchunks-overlay /tmp/rawchunks-source.json /tmp/rawchunks-patch.py

RUN uv pip install --python /app/ACE-Step-1.5/.venv/bin/python redis==6.4.0

WORKDIR /app/ACE-Step-1.5
EXPOSE 8001
CMD ["uv", "run", "--no-sync", "python", "-m", "acestep.api_server", "--host", "0.0.0.0", "--port", "8001"]

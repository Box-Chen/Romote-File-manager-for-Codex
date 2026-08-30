#!/bin/sh
if [ "$1" = "-G" ]; then
  printf '%s\n' 'hostname fake.example' 'user tester' 'port 22'
  exit 0
fi
last=''
for argument do last=$argument; done
exec /bin/sh -c "$last"

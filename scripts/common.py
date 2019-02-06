# Python 3.6

def yes_no_to_bool(answer, default): # default should be a bool
    answer = answer.lower()
    if answer == 'y' or answer == 'yes':
        return True
    elif answer == 'n' or answer == 'no':
        return False
    else:
        print('Invalid yes or no format. Defaulting to: {}'.format(default))
        return bool(default)

def request_input(caption, default):
    response = input('{} '.format(caption) + ('({}): '.format(default) if default else ''))
    return response if response != '' else default